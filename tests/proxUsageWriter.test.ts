import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UsageWriter, writerWorkerPath } from '../server/usage/writer';
import { UsageStore, openUsageReader } from '../server/usage/store';
import { WriterQueue } from '../server/usage/writerQueue';
import { usagePayload } from './fixtures/usagePayloads';
import { eventually } from './helpers/usageFakeProxy';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
function paths() {
  const dir = mkdtempSync(join('/dev/shm', 'prox-usage-writer-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { events: join(dir, 'usage.sqlite'), raw: join(dir, 'usage-raw.sqlite'), dir };
}
async function writerAt(files: ReturnType<typeof paths>, now = Date.now()) {
  const writer = new UsageWriter();
  cleanups.push(() => writer.close());
  await writer.init(files, ['test-proxy'], now);
  return writer;
}
const item = (id: string) => ({
  instance: 'test-proxy',
  ingest: 0 as const,
  payload: JSON.stringify(usagePayload({ execution_id: id })),
  label: { label: 'Worker snapshot', account: 'snapshot@example.test' },
});

describe('usage writer worker', () => {
  test('startup records provisional heartbeat coverage and replay clears a fully recovered outage', async () => {
    const files = paths();
    const store = new UsageStore({ events: files.events, raw: null });
    const now = 1_800_000_000_000;
    const last = now - 3_700_000;
    store.setMeta('heartbeat:test-proxy', String(last));
    store.close();
    const writer = await writerAt(files, now);
    expect(writer.status.gaps).toBe(1);
    expect(await writer.resume('test-proxy')).toEqual({ cursor: null, heartbeat: last });
    await writer.replay('test-proxy', [], { bootId: 'test-boot', queueSeq: 0 }, undefined, true);
    expect(writer.status.gaps).toBe(0);
  });

  test('new/fresh heartbeats do not create gaps; explicit drops are durable', async () => {
    const files = paths();
    const writer = await writerAt(files);
    expect(writer.status.gaps).toBe(0);
    await writer.heartbeat('test-proxy', 1234);
    await writer.gap({
      instance: 'test-proxy',
      fromMs: 1000,
      toMs: 1234,
      reason: 'writer-overflow',
    });
    expect(writer.status.gaps).toBe(1);
    const reader = openUsageReader(files.events);
    try {
      expect(
        reader.query("SELECT value FROM meta WHERE key = 'heartbeat:test-proxy'").get()
      ).toEqual({ value: '1234' });
      expect(reader.query('SELECT reason FROM ingest_gaps').get()).toEqual({
        reason: 'writer-overflow',
      });
    } finally {
      reader.close();
    }
  });

  test('commits at 50ms or 100 events, deduplicates and flushes pending batches', async () => {
    const files = paths();
    const writer = await writerAt(files);
    writer.enqueue(item('first'));
    expect(writer.backlog).toBe(1);
    await eventually(() => writer.status.inserted === 1, '50ms commit');
    for (let i = 0; i < 100; i += 1) writer.enqueue(item(`batch-${i}`));
    await writer.flush();
    writer.enqueue(item('first'));
    await writer.flush();
    expect(writer.status).toMatchObject({ inserted: 101, duplicates: 1, backlog: 0 });
    const reader = openUsageReader(files.events);
    try {
      expect(reader.query("SELECT value FROM dim WHERE kind = 'account_label'").get()).toEqual({
        value: 'Worker snapshot',
      });
    } finally {
      reader.close();
    }
  });

  test('raw-buffer failure after the event commit keeps the batch, counts it and accepts the next', async () => {
    const files = paths();
    const seed = new UsageStore(files);
    seed.close();
    const raw = new Database(files.raw);
    raw.exec(
      "CREATE TRIGGER fail_payload BEFORE INSERT ON payloads BEGIN SELECT RAISE(ABORT, 'synthetic raw failure'); END"
    );
    raw.close();
    const writer = await writerAt(files);
    writer.enqueue(item('raw-fails-1'));
    await writer.flush();
    expect(writer.status).toMatchObject({ inserted: 1, backlog: 0, rawBufferFailures: 1 });
    writer.enqueue(item('raw-fails-2'));
    await writer.flush();
    expect(writer.status).toMatchObject({ inserted: 2, backlog: 0, rawBufferFailures: 2 });
    const reader = openUsageReader(files.events);
    try {
      expect(reader.query('SELECT count(*) AS count FROM events').get()).toEqual({ count: 2 });
    } finally {
      reader.close();
    }
  });

  test('event-store failures fail the bridge and keep the backlog visible', async () => {
    const files = paths();
    const seed = new UsageStore(files);
    seed.close();
    const db = new Database(files.events);
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END"
    );
    db.close();
    const writer = new UsageWriter();
    // close still terminates the worker after a failed flush.
    cleanups.push(async () => {
      try {
        await writer.close();
      } catch {
        /* Expected fatal failure. */
      }
    });
    await writer.init(files, ['test-proxy']);
    let failed = false;
    writer.onFailure = () => {
      failed = true;
    };
    writer.enqueue({ ...item('cannot-commit'), cursor: { bootId: 'failure-boot', queueSeq: 7 } });
    let rejected = false;
    try {
      await writer.flush();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(failed).toBe(true);
    expect(writer.backlog).toBe(1);
    expect(() => writer.enqueue(item('next'))).toThrow();
    const reader = openUsageReader(files.events);
    try {
      expect(
        reader.query("SELECT value FROM meta WHERE key = 'cursor:test-proxy'").get()
      ).toBeNull();
      expect(reader.query('SELECT count(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      reader.close();
    }
  });

  test('replay never advances past a failed live batch whose coverage it relies on', async () => {
    const files = paths();
    const seed = new UsageStore(files);
    seed.close();
    const db = new Database(files.events);
    db.exec(
      "CREATE TRIGGER fail_live BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic live failure'); END"
    );
    db.close();
    const writer = new UsageWriter();
    cleanups.push(async () => {
      try {
        await writer.close();
      } catch {
        /* Expected fatal live-commit failure. */
      }
    });
    await writer.init(files, ['test-proxy']);
    // During replay the live record has no cursor. Advancing a later page relies
    // on successfully committing that live record, even if it was pruned upstream.
    writer.enqueue(item('live-covered-but-uncommitted'));
    let failed = false;
    try {
      await writer.replay('test-proxy', [], { bootId: 'failure-boot', queueSeq: 7 });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const reader = openUsageReader(files.events);
    try {
      expect(
        reader.query("SELECT value FROM meta WHERE key = 'cursor:test-proxy'").get()
      ).toBeNull();
      expect(reader.query('SELECT count(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      reader.close();
    }
  });

  test('built worker entry starts from a runtime path beside the main bundle', async () => {
    const files = paths();
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, '../server/usage/writer.worker.ts')],
      outdir: files.dir,
      target: 'bun',
      naming: 'writer.worker.js',
    });
    expect(result.success).toBe(true);
    const writer = new UsageWriter(join(files.dir, 'writer.worker.js'));
    cleanups.push(() => writer.close());
    await writer.init(files, ['test-proxy']);
    writer.enqueue(item('built-worker'));
    await writer.flush();
    expect(writer.status.inserted).toBe(1);
    expect(writerWorkerPath()).toEndWith('/server/usage/writer.worker.ts');
  });
});

test('live jobs run before queued bulk chunks, with one running job at a time', async () => {
  const queue = new WriterQueue();
  const seen: string[] = [];
  let release!: () => void;
  const first = queue.enqueueJob('import', async () => {
    seen.push('running');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await eventually(() => seen.length === 1);
  const bulk = queue.enqueueJob('prune', () => {
    seen.push('bulk');
  });
  const live = queue.enqueueJob('live', () => {
    seen.push('live');
  });
  release();
  await Promise.all([first, bulk, live]);
  expect(seen).toEqual(['running', 'live', 'bulk']);
  await expect(
    queue.enqueueJob('backup', () => {
      throw new Error('test');
    })
  ).rejects.toThrow('test');
  expect(await queue.enqueueJob('live', () => 42)).toBe(42);
});

test('close rejects promptly after a worker exits instead of posting to a dead worker', async () => {
  const files = paths();
  const entry = join(files.dir, 'exits.worker.ts');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    entry,
    `
    self.onmessage = ({ data }) => {
      self.postMessage({ id: data.id, ok: true, body: {
        backlog: 0, inserted: 0, duplicates: 0, rejected: 0, rawBufferFailures: 0, gaps: 0
      } });
      setTimeout(() => process.exit(1), 0);
    };
  `
  );
  const writer = new UsageWriter(entry);
  let failed = false;
  writer.onFailure = () => {
    failed = true;
  };
  await writer.init({ events: files.events, raw: null }, []);
  await eventually(() => failed, 'worker exit notification');
  const began = performance.now();
  let error: unknown;
  try {
    await writer.close();
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain('Usage writer unavailable');
  expect(performance.now() - began).toBeLessThan(500);
});
