import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageWriter } from '../server/usage/writer';
import { UsageStore } from '../server/usage/store';
import { createUsageStatusHandler } from '../server/usage/status';
import {
  BULK_JOB_KINDS,
  type BulkJobConfig,
  type BulkJobKind,
} from '../server/usage/writerProtocol';
import { createCpamp } from './fixtures/cpampUsage';
import { usagePayload } from './fixtures/usagePayloads';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(savedOutcomes: Partial<Record<BulkJobKind, string>> = {}) {
  const root = mkdtempSync('/dev/shm/prox-job-health-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cpampPath = join(root, 'cpamp.sqlite');
  const source = createCpamp(cpampPath, 1);
  cleanups.push(() => source.db.close());
  const psiPath = join(root, 'psi');
  const psi = (pressure: number) => writeFileSync(psiPath, `full avg10=${pressure} avg60=0`);
  psi(0);
  const entry = join(root, 'writer.ts');
  writeFileSync(
    entry,
    `
    import { readFileSync } from 'node:fs';
    import { startUsageWriterWorker } from ${JSON.stringify(join(import.meta.dir, '../server/usage/writerRuntime.ts'))};
    // Consume the backup stream without opening a socket or contacting an external service.
    globalThis.fetch = async (_url, options) => {
      await new Response(options.body).arrayBuffer();
      return new Response('');
    };
    startUsageWriterWorker({ readPsi: () => readFileSync(${JSON.stringify(psiPath)}, 'utf8') });
  `
  );
  const backupConfigPath = join(root, 'backup.json');
  writeFileSync(
    backupConfigPath,
    JSON.stringify({
      endpoint: 'https://backup.example.test',
      bucket: 'synthetic',
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
      tmpfsDir: root,
    })
  );
  const paths = { events: join(root, 'usage.sqlite'), raw: null };
  if (Object.keys(savedOutcomes).length) {
    const seed = new UsageStore(paths);
    try {
      for (const [kind, value] of Object.entries(savedOutcomes))
        seed.setMeta(`job-outcome:${kind}`, value);
    } finally {
      seed.close();
    }
  }
  let writer = new UsageWriter(entry);
  cleanups.push(() => writer.close());
  const init = (config: BulkJobConfig = {}) =>
    writer.init(
      paths,
      [],
      Date.now(),
      { cpampPath, backupConfigPath, ...config },
      {
        rateBookPath: join(root, 'missing-rates.json'),
        clientAliasesPath: join(root, 'missing-aliases.json'),
      }
    );
  await init();
  return {
    get writer() {
      return writer;
    },
    root,
    psi,
    async restart(config: BulkJobConfig = {}) {
      await writer.close();
      writer = new UsageWriter(entry);
      await init(config);
    },
  };
}

async function finished(writer: UsageWriter) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const report = await writer.jobReport();
    if (report?.finishedAtMs !== null && report?.finishedAtMs !== undefined) return report;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for terminal job');
}

const emptyHealth = (): Record<
  BulkJobKind,
  { last_success_seconds: number | null; last_failure_seconds: number | null }
> =>
  Object.fromEntries(
    BULK_JOB_KINDS.map((kind) => [kind, { last_success_seconds: null, last_failure_seconds: null }])
  );

test('all bulk kinds persist success and failure timestamps across writer restarts', async () => {
  const f = await fixture();
  const expected = emptyHealth();
  for (const kind of BULK_JOB_KINDS) {
    await f.writer.startJob(kind);
    const report = await finished(f.writer);
    expect(report.state).toBe('succeeded');
    expected[kind].last_success_seconds = report.finishedAtMs! / 1000;
  }
  await f.restart({ bytesPerSecond: -1 });
  expect((await f.writer.exporterSnapshot()).jobs).toEqual(expected);
  for (const kind of BULK_JOB_KINDS) {
    await f.writer.startJob(kind);
    const report = await finished(f.writer);
    expect(report.state).toBe('failed');
    expected[kind].last_failure_seconds = report.finishedAtMs! / 1000;
  }
  expect((await f.writer.exporterSnapshot()).jobs).toEqual(expected);
  await f.restart();
  expect(await f.writer.jobReport()).toBeNull();
  expect((await f.writer.exporterSnapshot()).jobs).toEqual(expected);
  await f.writer.startJob('prune');
  const latest = await finished(f.writer);
  expect(latest.state).toBe('succeeded');
  expected.prune.last_success_seconds = latest.finishedAtMs! / 1000;
  await f.restart();
  expect((await f.writer.exporterSnapshot()).jobs).toEqual(expected);
}, 15_000);

test('cancelled jobs preserve both previous outcomes and never-run nulls after restart', async () => {
  const f = await fixture();
  await f.writer.startJob('import');
  expect((await finished(f.writer)).state).toBe('succeeded');
  await f.restart({ bytesPerSecond: -1 });
  await f.writer.startJob('import');
  expect((await finished(f.writer)).state).toBe('failed');
  await f.restart();
  const before = (await f.writer.exporterSnapshot()).jobs;
  expect(before).toMatchObject({ import: { last_success_seconds: expect.any(Number) } });
  f.psi(5);
  for (const kind of ['import', 'reconcile'] as const) {
    const started = await f.writer.startJob(kind);
    expect((await f.writer.jobReport())?.finishedAtMs).toBeNull();
    expect((await f.writer.exporterSnapshot()).jobs).toEqual(before);
    await f.writer.cancelJob(started.id);
    expect((await finished(f.writer)).state).toBe('cancelled');
    expect((await f.writer.exporterSnapshot()).jobs).toEqual(before);
  }
  await f.restart();
  expect((await f.writer.exporterSnapshot()).jobs).toEqual(before);
});

test('exporter HTTP JSON adds all job kinds while retaining its version-1 shape', async () => {
  const f = await fixture();
  await f.writer.startJob('prune');
  const report = await finished(f.writer);
  const keyFile = join(f.root, 'key');
  writeFileSync(keyFile, 'synthetic-key');
  const handler = createUsageStatusHandler({
    keyFile,
    sources: () => [],
    writer: () => f.writer.status,
    healthy: () => true,
    exporter: () => f.writer.exporterSnapshot(),
  });
  const response = await handler(
    new Request('http://127.0.0.1/v1/exporter', {
      headers: { Authorization: 'Bearer synthetic-key' },
    })
  );
  expect(response.status).toBe(200);
  const expected = emptyHealth();
  expected.prune.last_success_seconds = report.finishedAtMs! / 1000;
  expect(await response.json()).toMatchObject({
    schema_version: 1,
    groups: [],
    newest_event_time_seconds: 0,
    models_priced: expect.any(Number),
    jobs: expected,
    jobs_outcome_error: false,
    sources: [],
  });
});

test.each([
  ['{', null, null],
  ['null', null, null],
  ['[]', null, null],
  ['{"lastSuccessAtMs":"5"}', null, null],
  ['{"lastSuccessAtMs":-5,"lastFailureAtMs":null}', null, null],
  ['{"lastSuccessAtMs":1.5,"lastFailureAtMs":null}', null, null],
  ['{"lastSuccessAtMs":1e999,"lastFailureAtMs":null}', null, null],
  ['{"lastSuccessAtMs":12345,"lastFailureAtMs":"5"}', 12.345, null],
  ['{"lastSuccessAtMs":-5,"lastFailureAtMs":12345}', null, 12.345],
  ['{}', null, null],
] as const)(
  'invalid saved job outcomes %s preserve ingestion and exporter availability',
  async (saved, success, failure) => {
    const f = await fixture({
      import: saved,
      reconcile: '{"lastSuccessAtMs":12345,"lastFailureAtMs":67890}',
    });
    let failed = false;
    f.writer.onFailure = () => {
      failed = true;
    };
    f.writer.enqueue({
      instance: 'test',
      ingest: 0,
      payload: JSON.stringify(usagePayload({ execution_id: 'after-invalid-outcome' })),
    });
    await f.writer.flush();
    expect(f.writer.status.inserted).toBe(1);
    expect(failed).toBe(false);
    expect(await f.writer.exporterSnapshot()).toMatchObject({
      schema_version: 1,
      jobs_outcome_error: true,
      jobs: {
        import: { last_success_seconds: success, last_failure_seconds: failure },
        reconcile: { last_success_seconds: 12.345, last_failure_seconds: 67.89 },
      },
      groups: [{ requests: 1 }],
    });
  }
);

test('valid saved job outcomes accept zero and null without an outcome error', async () => {
  const f = await fixture({
    import: '{"lastSuccessAtMs":0,"lastFailureAtMs":null}',
    reconcile: '{"lastSuccessAtMs":null,"lastFailureAtMs":12345}',
  });
  expect(await f.writer.exporterSnapshot()).toMatchObject({
    jobs_outcome_error: false,
    jobs: {
      import: { last_success_seconds: 0, last_failure_seconds: null },
      reconcile: { last_success_seconds: null, last_failure_seconds: 12.345 },
    },
  });
});
