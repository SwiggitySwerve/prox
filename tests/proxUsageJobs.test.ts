import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageWriter } from '../server/usage/writer';
import { createUsageStatusHandler } from '../server/usage/status';
import type { BulkJobConfig, BulkJobReport } from '../server/usage/writerProtocol';
import { openUsageReader } from '../server/usage/store';
import { createCpamp, cpampRow, createCpampRollups } from './fixtures/cpampUsage';
import { usagePayload } from './fixtures/usagePayloads';
import { eventually } from './helpers/usageFakeProxy';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function fixture(count = 1, pressure = 0, config: BulkJobConfig = {}, raw = false) {
  const root = mkdtempSync('/dev/shm/prox-jobs-test-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cpampPath = join(root, 'cpamp.sqlite');
  const source = createCpamp(cpampPath, count);
  cleanups.push(() => source.db.close());
  const psiPath = join(root, 'psi');
  const psi = (value: number) => writeFileSync(psiPath, `full avg10=${value} avg60=0`);
  psi(pressure);
  const entry = join(root, 'writer.ts');
  writeFileSync(
    entry,
    `
    import { readFileSync } from 'node:fs';
    import { startUsageWriterWorker } from ${JSON.stringify(join(import.meta.dir, '../server/usage/writerRuntime.ts'))};
    startUsageWriterWorker({ readPsi: () => readFileSync(${JSON.stringify(psiPath)}, 'utf8') });
  `
  );
  const writer = new UsageWriter(entry);
  const closeCleanup = () => writer.close();
  cleanups.push(closeCleanup);
  const events = join(root, 'usage.sqlite');
  await writer.init({ events, raw: raw ? join(root, 'raw.sqlite') : null }, [], Date.now(), {
    cpampPath,
    backupConfigPath: join(root, 'missing-config.json'),
    ...config,
  });
  const reader = openUsageReader(events);
  cleanups.push(() => reader.close());
  return { root, source, writer, reader, psi, closeCleanup };
}
const live = (id: string) => ({
  instance: 'test',
  ingest: 0 as const,
  payload: JSON.stringify(usagePayload({ execution_id: id })),
});
async function reportWhen(writer: UsageWriter, predicate: (report: BulkJobReport) => boolean) {
  for (let i = 0; i < 500; i += 1) {
    const report = await writer.jobReport();
    if (report && predicate(report)) return report;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for bulk report');
}
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error('Expected RPC rejection');
}
const finished = (report: BulkJobReport) => report.finishedAtMs !== null;

function persistedExceptVerifyOutcome(db: Database) {
  return Object.fromEntries(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all()
      .map(({ name }) => {
        const table = `"${name.replaceAll('"', '""')}"`;
        const where = name === 'meta' ? " WHERE key != 'job-outcome:verify'" : '';
        const sql = `SELECT * FROM ${table}${where}`;
        const order = db
          .query(sql)
          .columnNames.map((_, index) => index + 1)
          .join(', ');
        return [name, db.query(`${sql} ORDER BY ${order}`).all()];
      })
  );
}

test('worker runs import, reconcile and verify changing only its outcome with exact typed reports', async () => {
  const f = await fixture(1001);
  expect(await f.writer.jobReport()).toBeNull(); // boot starts no bulk work
  const started = await f.writer.startJob('import');
  expect(started).toMatchObject({ kind: 'import', state: 'running', finishedAtMs: null });
  const imported = await reportWhen(f.writer, finished);
  expect(imported).toMatchObject({
    state: 'succeeded',
    progress: { phase: 'verify', read: 1001 },
    result: { kind: 'cpamp', report: { inserted: 1001, verification: { exact: true } } },
  });
  f.source.add(cpampRow(1002));
  await f.writer.startJob('reconcile');
  const reconciled = await reportWhen(f.writer, finished);
  expect(reconciled).toMatchObject({
    id: started.id + 1,
    result: {
      report: { mode: 'reconcile', inserted: 1, lastId: 1002, verification: { exact: true } },
    },
  });

  const before = persistedExceptVerifyOutcome(f.reader);
  const outcome = () =>
    f.reader
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'job-outcome:verify'")
      .get();
  expect(outcome()).toBeNull();

  await f.writer.startJob('verify');
  const verified = await reportWhen(f.writer, finished);
  expect(verified).toMatchObject({
    state: 'succeeded',
    result: { report: { mode: 'verify', verification: { read: 1002, exact: true } } },
  });

  expect(persistedExceptVerifyOutcome(f.reader)).toEqual(before);
  expect(JSON.parse(outcome()!.value)).toEqual({
    lastSuccessAtMs: verified.finishedAtMs,
    lastFailureAtMs: null,
  });

  expect(f.writer.status.job?.state).toBe('succeeded');
}, 15_000);

test('live commits and flush complete during PSI wait; busy/stale cancels are nonfatal', async () => {
  const f = await fixture(1, 5);
  let failed = false;
  f.writer.onFailure = () => {
    failed = true;
  };
  const started = await f.writer.startJob('import');
  expect(await rejection(f.writer.startJob('backup'))).toContain('Bulk job unavailable');
  expect(await rejection(f.writer.cancelJob(started.id + 1))).toContain('ID differs');
  f.writer.enqueue(live('during-pressure'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  expect((await f.writer.jobReport())?.state).toBe('running');
  expect(f.reader.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
  await f.writer.cancelJob(started.id);
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'cancelled' });
  expect(failed).toBe(false);
  f.psi(0);
  await f.writer.startJob('import');
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'succeeded' });
});

test('shutdown cancels pressure wait and retains the final accepted live batch', async () => {
  const f = await fixture(1, 5);
  let failed = false;
  f.writer.onFailure = () => {
    failed = true;
  };
  await f.writer.startJob('import');
  f.writer.enqueue(live('shutdown-pressure'));
  const began = performance.now();
  const closing = f.writer.close();
  expect(await rejection(f.writer.startJob('backup'))).toContain('closing');
  await closing;
  expect(await rejection(f.writer.jobReport())).toContain('closing');
  expect(() => f.writer.enqueue(live('too-late'))).toThrow('closing');
  expect(performance.now() - began).toBeLessThan(1500);
  expect(f.writer.status.job).toMatchObject({
    state: 'cancelled',
    finishedAtMs: expect.any(Number),
  });
  expect(f.reader.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
  expect(failed).toBe(false);
});

test('live batches commit while source-open bytes are paced; shutdown settles and closes the source', async () => {
  const f = await fixture(1, 0, { bytesPerSecond: 1 });
  await f.writer.startJob('import');
  const pacing = await reportWhen(f.writer, (r) => r.io.bytesRead > 0);
  expect(pacing.state).toBe('running');
  f.writer.enqueue(live('during-pacing'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  expect((await f.writer.jobReport())?.state).toBe('running');
  await f.writer.close();
  expect(f.writer.status.job?.state).toBe('cancelled');
  // Reopening exclusive proves the read-only handle was released before worker exit.
  f.source.db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
});

test('bad source and backup config failures report safely and keep live ingestion', async () => {
  const f = await fixture();
  let failed = false;
  f.writer.onFailure = () => {
    failed = true;
  };
  f.source.db.exec('DROP TABLE usage_events');
  await f.writer.startJob('verify');
  const sourceFailure = await reportWhen(f.writer, finished);
  expect(sourceFailure).toMatchObject({ state: 'failed', error: expect.any(String) });
  expect(JSON.stringify(sourceFailure)).not.toContain(f.root);
  await f.writer.startJob('backup');
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'failed' });
  f.writer.enqueue(live('after-bulk-failures'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  expect(failed).toBe(false);
});

test('backup upload stays outside the queue; cancel/shutdown removes tmpfs files and retains success', async () => {
  let delay = false;
  let uploadSeen = 0;
  let release!: () => void;
  let bytes: Uint8Array | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      bytes = new Uint8Array(await request.arrayBuffer());
      uploadSeen += 1;
      if (delay)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return new Response('');
    },
  });
  cleanups.push(() => {
    release?.();
    server.stop(true);
  });
  const configRoot = mkdtempSync('/dev/shm/prox-jobs-config-');
  cleanups.push(() => rmSync(configRoot, { recursive: true, force: true }));
  const backupConfigPath = join(configRoot, 'backup.json');
  writeFileSync(
    backupConfigPath,
    JSON.stringify({
      endpoint: server.url.origin,
      bucket: 'synthetic',
      accessKeyId: 'SYNTHETIC-KEY',
      secretAccessKey: 'SYNTHETIC-SECRET',
      tmpfsDir: configRoot,
    })
  );
  const f = await fixture(1, 0, { backupConfigPath });
  f.writer.enqueue(live('backed-up'));
  await f.writer.flush();
  await f.writer.startJob('backup');
  const success = await reportWhen(f.writer, finished);
  expect(success).toMatchObject({
    state: 'succeeded',
    result: { kind: 'backup' },
    lastBackupSuccessAtMs: expect.any(Number),
  });
  const restored = Database.deserialize(bytes!);
  expect(restored.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
  restored.close();
  expect(readdirSync(configRoot)).toEqual(['backup.json']);
  delay = true;
  const previousUploads = uploadSeen;
  await f.writer.startJob('backup');
  await eventually(() => uploadSeen > previousUploads);
  f.writer.enqueue(live('during-upload'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(2);
  await f.writer.close();
  expect(f.writer.status.job).toMatchObject({
    state: 'cancelled',
    lastBackupSuccessAtMs: success.lastBackupSuccessAtMs,
  });
  expect(readdirSync(configRoot)).toEqual(['backup.json']);
});

test('a failed bulk transaction is nonfatal and a later reconcile can resume', async () => {
  const f = await fixture();
  const instrument = new Database(f.reader.filename);
  cleanups.push(() => instrument.close());
  instrument.exec(
    "CREATE TRIGGER fail_cursor BEFORE INSERT ON meta WHEN NEW.key='import:cpamp:last_id' BEGIN SELECT RAISE(ABORT, 'synthetic bulk failure'); END"
  );
  let failed = false;
  f.writer.onFailure = () => {
    failed = true;
  };
  await f.writer.startJob('import');
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'failed' });
  expect(f.reader.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
  f.writer.enqueue(live('bulk-rollback-live'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  instrument.exec('DROP TRIGGER fail_cursor');
  await f.writer.startJob('reconcile');
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'succeeded' });
  expect(failed).toBe(false);
});

test('a live event failure stays fatal and close still settles an active bulk job', async () => {
  const f = await fixture(1, 5);
  const instrument = new Database(f.reader.filename);
  cleanups.push(() => instrument.close());
  instrument.exec(
    "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic live failure'); END"
  );
  let failed = false;
  f.writer.onFailure = () => {
    failed = true;
  };
  await f.writer.startJob('import');
  f.writer.enqueue(live('fatal-during-bulk'));
  expect(await rejection(f.writer.flush())).toContain('Usage writer failed');
  expect(failed).toBe(true);
  expect(await rejection(f.writer.close())).toContain('Usage writer unavailable');
  cleanups.splice(cleanups.indexOf(f.closeCleanup), 1);
  expect(f.writer.status.job?.state).toBe('cancelled');
});

test('boot leaves missing CPAMP sources unopened and reports an explicit start failure nonfatally', async () => {
  const f = await fixture(0, 0, { cpampPath: '/dev/shm/prox-jobs-source-must-not-exist.sqlite' });
  expect(await f.writer.jobReport()).toBeNull();
  await f.writer.startJob('verify');
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'failed' });
  f.writer.enqueue(live('missing-source-live'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
});

test('cancel settles a paced upload pull before reusing the shared governor', async () => {
  const root = mkdtempSync('/dev/shm/prox-paced-upload-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      try {
        await request.arrayBuffer();
      } catch {
        return new Response('', { status: 400 });
      }
      return new Response('');
    },
  });
  cleanups.push(() => server.stop(true));
  const backupConfigPath = join(root, 'config.json');
  writeFileSync(
    backupConfigPath,
    JSON.stringify({
      endpoint: server.url.origin,
      bucket: 'synthetic',
      accessKeyId: 'SYNTHETIC-KEY',
      secretAccessKey: 'SYNTHETIC-SECRET',
      tmpfsDir: root,
    })
  );
  const f = await fixture(0, 0, { backupConfigPath, bytesPerSecond: 200_000 });
  const started = await f.writer.startJob('backup');
  // Snapshot accounting has unequal read/write bytes. The next increment adds a
  // 64 KiB tmpfs read and network write before the paced pull sends those bytes.
  const snapshot = await reportWhen(f.writer, (r) => r.io.bytesRead > 0);
  await reportWhen(f.writer, (r) => r.io.bytesRead > snapshot.io.bytesRead);
  await f.writer.cancelJob(started.id);
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'cancelled' });
  expect(readdirSync(root)).toEqual(['config.json']);
  const settledBytes = (await f.writer.jobReport())!.io;
  await Bun.sleep(25);
  expect((await f.writer.jobReport())!.io).toEqual(settledBytes);
  f.writer.enqueue(live('after-paced-upload-cancel'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
});

test('without pacing sleeps, worker messages interrupt a pass between bounded chunks', async () => {
  const f = await fixture(15_001, 0, { bytesPerSecond: 1e15 });
  const started = await f.writer.startJob('verify');
  await reportWhen(f.writer, (r) => (r.progress?.read ?? 0) > 0);
  f.writer.enqueue(live('no-pacing-live'));
  await f.writer.flush();
  const during = await f.writer.jobReport();
  expect(f.writer.status.inserted).toBe(1);
  expect(during?.state).toBe('running');
  expect(during?.progress?.read).toBeLessThan(15_001);
  const cancelled = await f.writer.cancelJob(started.id);
  expect(cancelled.state).toBe('cancelling');
  const settled = await reportWhen(f.writer, finished);
  expect(settled.state).toBe('cancelled');
  // No further chunk runs after the worker handles the cancel message.
  expect(settled.progress).toEqual(cancelled.progress);
}, 15_000);

test('worker reuse preserves outstanding byte debt after a cancelled job', async () => {
  const f = await fixture(1, 0, { bytesPerSecond: 1 });
  const started = await f.writer.startJob('import');
  const pacing = await reportWhen(f.writer, (r) => r.io.bytesRead > 0);
  await f.writer.cancelJob(started.id);
  expect((await reportWhen(f.writer, finished)).state).toBe('cancelled');
  const restarted = await f.writer.startJob('verify');
  await Bun.sleep(100);
  const waiting = await f.writer.jobReport();
  expect(waiting?.state).toBe('running');
  expect(waiting?.io.bytesRead).toBe(pacing.io.bytesRead);
  expect(waiting?.io.bytesWritten).toBe(pacing.io.bytesWritten);
  f.writer.enqueue(live('during-retained-debt'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  await f.writer.cancelJob(restarted.id);
  expect((await reportWhen(f.writer, finished)).state).toBe('cancelled');
});

test('worker reports imported-cohort counts and independent CPAMP rollup checks', async () => {
  const f = await fixture(1, 0, { bytesPerSecond: 1e15 });
  const addRollup = createCpampRollups(f.source.db);
  addRollup();
  await f.writer.startJob('import');
  const imported = await reportWhen(f.writer, finished);
  expect(imported).toMatchObject({
    state: 'succeeded',
    result: {
      kind: 'cpamp',
      report: {
        verification: {
          exact: true,
          targetOnlyImported: 0,
          rollups: {
            available: true,
            complete: true,
            mismatches: [],
            uncovered: [],
            hours: [{ equal: true, cpamp: { rows: '1' }, prox: { rows: '1' } }],
          },
        },
      },
    },
  });
  f.source.db.exec('UPDATE usage_pricing_hourly_provider_rollups_v1 SET calls=2');
  await f.writer.startJob('verify');
  const mismatch = await reportWhen(f.writer, finished);
  expect(mismatch).toMatchObject({
    state: 'succeeded',
    result: {
      report: {
        verification: {
          exact: false,
          rollups: { complete: true, mismatches: [{ equal: false }] },
        },
      },
    },
  });
});

test('prune bounds raw pages, yields to live batches, and preserves fresh rows and events', async () => {
  const f = await fixture(0, 0, { bytesPerSecond: 1e15 }, true);
  const raw = new Database(join(f.root, 'raw.sqlite'));
  cleanups.push(() => raw.close());
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const fresh = Date.now();
  raw.transaction(() => {
    const payload = raw.query('INSERT INTO payloads VALUES (?, ?, 0, ?)');
    const reject = raw.query("INSERT INTO rejects VALUES (?, ?, 'not-json', NULL, NULL)");
    for (let i = 1; i <= 15_001; i += 1) {
      payload.run(i + 100_000, i % 2 ? old : fresh, new Uint8Array());
      reject.run(i, i % 2 ? old : fresh);
    }
  })();
  const started = await f.writer.startJob('prune');
  const during = await reportWhen(
    f.writer,
    (r) => r.result?.kind === 'prune' && r.result.report.chunks > 0
  );
  expect(during.state).toBe('running');
  if (during.result?.kind !== 'prune') throw new Error('Expected prune result');
  expect(during.result.report.deleted).toBeLessThanOrEqual(during.result.report.chunks * 2000);
  f.writer.enqueue({
    ...live('prune-live'),
    payload: JSON.stringify(
      usagePayload({
        execution_id: 'prune-live',
        timestamp: new Date().toISOString(),
      })
    ),
  });
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  expect((await f.writer.jobReport())?.state).toBe('running');
  const settled = await reportWhen(f.writer, finished);
  expect(settled).toMatchObject({
    id: started.id,
    state: 'succeeded',
    result: { kind: 'prune', report: { chunks: 16, deleted: 15_002 } },
  });
  for (const table of ['payloads', 'rejects']) {
    expect(raw.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
      n: table === 'payloads' ? 7501 : 7500,
    });
  }
  expect(f.reader.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
});

test('raw prune transaction failure is nonfatal and can be retried', async () => {
  const f = await fixture(0, 0, { bytesPerSecond: 1e15 }, true);
  const raw = new Database(join(f.root, 'raw.sqlite'));
  cleanups.push(() => raw.close());
  raw.query('INSERT INTO payloads VALUES (100001, 1, 0, ?)').run(new Uint8Array());
  raw.exec(
    "CREATE TRIGGER fail_prune BEFORE DELETE ON payloads BEGIN SELECT RAISE(ABORT, 'synthetic prune failure'); END"
  );
  let fatal = false;
  f.writer.onFailure = () => {
    fatal = true;
  };
  await f.writer.startJob('prune');
  expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'failed' });
  expect(raw.query('SELECT count(*) AS n FROM payloads').get()).toEqual({ n: 1 });
  f.writer.enqueue(live('after-prune-failure'));
  await f.writer.flush();
  expect(f.writer.status.inserted).toBe(1);
  expect(fatal).toBe(false);
  raw.exec('DROP TRIGGER fail_prune');
  await f.writer.startJob('prune');
  expect(await reportWhen(f.writer, finished)).toMatchObject({
    state: 'succeeded',
    result: { report: { deleted: 2 } }, // includes the old-timestamp live payload; its event stays
  });
});

test('job ownership token travels through HTTP and worker reports; mismatched cancellation is refused', async () => {
  const f = await fixture(0, 5);
  const keyFile = join(f.root, 'management-key');
  writeFileSync(keyFile, 'synthetic-owner-key');
  const handler = createUsageStatusHandler({
    keyFile,
    healthy: () => true,
    sources: () => [],
    writer: () => f.writer.status,
    jobs: f.writer,
  });
  const request = (path: string, body?: unknown) =>
    handler(
      new Request(`http://127.0.0.1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: 'Bearer synthetic-owner-key',
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  for (const clientToken of [
    '',
    'x'.repeat(65),
    'space token',
    'line\n',
    'slash/',
    'é',
    null,
    1,
    {},
    [],
  ]) {
    expect((await request('/v1/jobs', { kind: 'prune', clientToken })).status).toBe(400);
    expect((await request('/v1/jobs/cancel', { jobId: 1, clientToken })).status).toBe(400);
  }
  for (const clientToken of ['x', 'A_9-'.repeat(16)]) {
    const response = await request('/v1/jobs', { kind: 'prune', clientToken });
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as { job: BulkJobReport };
    expect(job.clientToken).toBe(clientToken);
    expect(await (await request('/v1/jobs')).json()).toMatchObject({
      job: { id: job.id, clientToken, state: 'running' },
    });
    expect(
      (await request('/v1/jobs/cancel', { jobId: job.id, clientToken: 'someone-else' })).status
    ).toBe(409);
    expect((await f.writer.jobReport())?.state).toBe('running');
    expect((await request('/v1/jobs/cancel', { jobId: job.id, clientToken })).status).toBe(202);
    expect(await reportWhen(f.writer, finished)).toMatchObject({ state: 'cancelled', clientToken });
  }
});
