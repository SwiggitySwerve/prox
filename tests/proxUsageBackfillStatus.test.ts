import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageStore } from '../server/usage/store';
import { UsageWriter } from '../server/usage/writer';
import { createUsageStatusHandler } from '../server/usage/status';
import { HOUR_MS } from '../server/usage/aggregate';
import {
  ROLLUP_BACKFILL_BUSY_ERROR,
  type RollupBackfillReport,
} from '../server/usage/writerProtocol';
import { BASE, event } from './helpers/usageAnalytics';

test('authenticated status reports live worker backfill state, failures and progress without job outcomes', async () => {
  const root = mkdtempSync('/dev/shm/prox-backfill-status-');
  const path = join(root, 'usage.sqlite');
  const start = Math.floor(BASE / HOUR_MS) * HOUR_MS;
  const seed = new UsageStore({ events: path, raw: null });
  seed.insert(
    [0, 1].map((i) => ({ event: event(i, { tsMs: start + i * HOUR_MS + 1 }), raw: null })),
    0
  );
  seed.close();
  const psiPath = join(root, 'psi');
  const pressure = (value: number) => writeFileSync(psiPath, `full avg10=${value} avg60=0`);
  pressure(5);
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, 'synthetic-status-key');
  const rateBookPath = join(root, 'rates.json');
  writeFileSync(rateBookPath, JSON.stringify({ version: 1, models: {} }));
  const entry = join(root, 'worker.ts');
  writeFileSync(
    entry,
    `
    import { readFileSync } from 'node:fs';
    import { startUsageWriterWorker } from ${JSON.stringify(join(import.meta.dir, '../server/usage/writerRuntime.ts'))};
    startUsageWriterWorker({
      readPsi: () => readFileSync(${JSON.stringify(psiPath)}, 'utf8'),
      clock: { now: () => performance.now(), sleep: (ms) => Bun.sleep(Math.min(ms, 10)) },
    });
  `
  );
  const worker = new UsageWriter(entry);
  const control = new Database(path);
  try {
    await worker.init(
      { events: path, raw: null, rateBookPath },
      [],
      Date.now(),
      { bytesPerSecond: 1e15 },
      { rateBookPath, clientAliasesPath: join(root, 'missing-aliases.json') }
    );
    const handler = createUsageStatusHandler({
      keyFile,
      healthy: () => true,
      sources: () => [],
      writer: () => worker.status,
      jobs: worker,
    });
    const request = (pathname: string, body?: object) =>
      handler(
        new Request(`http://127.0.0.1${pathname}`, {
          method: body ? 'POST' : 'GET',
          headers: { authorization: 'Bearer synthetic-status-key' },
          body: body ? JSON.stringify(body) : undefined,
        })
      );
    const status = async (): Promise<RollupBackfillReport> => {
      const response = await request('/v1/status');
      expect(response.status).toBe(200);
      const value = (await response.json()) as {
        writer: object;
        rollup: { backfill: RollupBackfillReport };
      };
      expect(value.writer).not.toHaveProperty('rollup');
      expect(value.rollup.backfill.hoursTotal).toBeNull();
      return value.rollup.backfill;
    };
    const until = async (predicate: (value: RollupBackfillReport) => boolean) => {
      for (let i = 0; i < 1500; i++) {
        const value = await status();
        if (predicate(value)) return value;
        await Bun.sleep(10);
      }
      throw new Error('Backfill status did not reach expected state');
    };
    expect((await handler(new Request('http://127.0.0.1/v1/status'))).status).toBe(401);
    expect(await status()).toMatchObject({
      state: 'running',
      currentHour: null,
      hoursCompleted: 0,
      pauseReason: null,
      lastFailure: null,
    });
    const manual = await worker.startJob('prune', 'status-test');
    expect(await until((v) => v.state === 'waiting-for-job')).toMatchObject({
      pauseReason: 'bulk-job',
      currentHour: null,
      hoursCompleted: 0,
    });
    await worker.cancelJob(manual.id, 'status-test');
    for (let i = 0; (await worker.jobReport())?.finishedAtMs === null && i < 200; i++)
      await Bun.sleep(10);
    pressure(0);
    expect(
      await until((v) => v.hoursCompleted === 1 && v.pauseReason === 'between-hours')
    ).toMatchObject({ state: 'paused', currentHour: start });
    pressure(5);
    expect(await until((v) => v.pauseReason === 'io-pressure')).toMatchObject({
      state: 'paused',
      hoursCompleted: 1,
    });
    const refused = await request('/v1/jobs', { kind: 'prune', clientToken: 'refused-test' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: ROLLUP_BACKFILL_BUSY_ERROR });
    const secret = 'SYNTHETIC-PRIVATE-DB-ERROR';
    control.exec(
      `CREATE TRIGGER fail_rollup BEFORE INSERT ON usage_hour_rollup BEGIN SELECT RAISE(ABORT, '${secret}'); END`
    );
    pressure(0);
    const failed = await until((v) => v.state === 'failed');
    expect(failed).toMatchObject({
      currentHour: start + HOUR_MS,
      hoursCompleted: 1,
      lastFailure: {
        atMs: expect.any(Number),
        hour: start + HOUR_MS,
        error: 'Usage hourly rollup rebuild failed; raw events retained',
      },
    });
    expect(JSON.stringify(failed)).not.toContain(secret);
    control.exec('DROP TRIGGER fail_rollup');
    const done = await until((v) => v.state === 'done');
    expect(done).toMatchObject({
      currentHour: null,
      hoursCompleted: 2,
      pauseReason: null,
      lastFailure: failed.lastFailure,
    });
    expect(control.query("SELECT key FROM meta WHERE key LIKE 'job-outcome:%'").all()).toEqual([]);
    expect((await (await request('/v1/jobs')).json()).job).toMatchObject({
      id: manual.id,
      state: 'cancelled',
    });
  } finally {
    await worker.close();
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
