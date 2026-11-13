import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageBulkJobs } from '../server/usage/bulkJobs';
import { WriterQueue } from '../server/usage/writerQueue';
import { createUsageStatusHandler } from '../server/usage/status';
import { HOUR_MS } from '../server/usage/aggregate';
import type { RollupWriteResult } from '../server/usage/rollup';
import { analyticsStore, BASE, book, event } from './helpers/usageAnalytics';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
  const f = analyticsStore();
  cleanups.push(() => f.close());
  const start = Math.floor(BASE / HOUR_MS) * HOUR_MS;
  f.insert([event(1, { tsMs: start + 1 }), event(2, { tsMs: start + HOUR_MS + 1 })]);
  const queue = new WriterQueue();
  let pressure = 0;
  const jobs = new UsageBulkJobs(
    f.store,
    queue.enqueueJob.bind(queue),
    {
      bytesPerSecond: 1e15,
    },
    { readPsi: () => `full avg10=${pressure} avg60=0` }
  );
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  cleanups.push(async () => {
    controller.abort();
    await Promise.allSettled([...pending, jobs.close()]);
  });
  const run = (
    work: () => RollupWriteResult | null = () => f.store.rebuildNextHour(book, start + 3 * HOUR_MS)
  ) => {
    const result = jobs.runRollupChunk(work, controller.signal);
    pending.push(result);
    void result.catch(() => {}); // A failed assertion can reach cleanup before the caller awaits.
    return result;
  };
  const keyFile = join(f.directory, 'key');
  writeFileSync(keyFile, 'synthetic-slot-key');
  const handler = createUsageStatusHandler({
    keyFile,
    healthy: () => true,
    sources: () => [],
    writer: () => ({
      backlog: 0,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      rawBufferFailures: 0,
      gaps: 0,
    }),
    jobs: {
      startJob: async (kind, token) => jobs.start(kind, token),
      cancelJob: async (id, token) => jobs.cancel(id, token),
      jobReport: async () => jobs.report(),
    },
  });
  const submit = (kind: string) =>
    handler(
      new Request('http://127.0.0.1/v1/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-slot-key' },
        body: JSON.stringify({ kind, clientToken: 'owned-by-test' }),
      })
    );
  return {
    ...f,
    jobs,
    run,
    submit,
    pressure: (value: number) => {
      pressure = value;
    },
    async drain() {
      for (let i = 0; i < 10; i++) {
        let result: RollupWriteResult | null | undefined;
        await run(() => (result = f.store.rebuildNextHour(book, start + 3 * HOUR_MS)));
        if (result === null) return;
      }
      throw new Error('Backfill did not drain');
    },
  };
}

test('bulk HTTP admission is 409 during a rollup wait and between hours until backfill drains', async () => {
  const f = setup();
  f.pressure(5);
  const first = f.run();
  for (const kind of ['import', 'reconcile', 'prune'])
    expect((await f.submit(kind)).status).toBe(409);
  expect(f.jobs.report()).toBeNull(); // No rejected submission acquires a client token or ID.
  expect(f.db.query("SELECT key FROM meta WHERE key LIKE 'job-outcome:%'").all()).toEqual([]);
  f.pressure(0);
  await first;
  expect(f.db.query('SELECT count(*) AS n FROM usage_hour_state WHERE dirty = 1').get()).toEqual({
    n: 1,
  });
  expect((await f.submit('prune')).status).toBe(409); // Between chunks, not just synchronous IO.
  await f.drain();
  expect(f.db.query("SELECT key FROM meta WHERE key LIKE 'job-outcome:%'").all()).toEqual([]);
  const admitted = await f.submit('prune');
  expect(admitted.status).toBe(202);
  expect(await admitted.json()).toMatchObject({
    job: { kind: 'prune', clientToken: 'owned-by-test' },
  });
});

test('a manual job admitted first pauses backfill without consuming its resumable progress', async () => {
  const f = setup();
  const manual = f.jobs.start('prune', 'manual-owner');
  let called = false;
  await f.run(() => {
    called = true;
    return f.store.rebuildNextHour(book, BASE + 3 * HOUR_MS);
  });
  expect(called).toBe(false);
  expect(f.db.query('SELECT count(*) AS n FROM usage_hour_state WHERE dirty = 1').get()).toEqual({
    n: 2,
  });
  expect(f.store.getMeta('rollup:discovery_ms')).toBeNull();
  f.jobs.cancel(manual.id, 'manual-owner');
  for (let i = 0; f.jobs.report()?.finishedAtMs === null && i < 200; i++) await Bun.sleep(10);
  expect(f.jobs.report()).toMatchObject({ state: 'cancelled', finishedAtMs: expect.any(Number) });
  f.pressure(0);
  await f.drain();
  expect(f.db.query('SELECT count(*) AS n FROM usage_hour_state WHERE dirty = 1').get()).toEqual({
    n: 0,
  });
});
