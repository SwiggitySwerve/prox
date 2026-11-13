// Real-data P5b gate: backfill cost, raw-vs-rollup 30-day latency and exact equality on a COPY of
// the live usage DB. Usage: bun scripts/usage-real-measure.ts <copy.sqlite> <usage-rates.json>
// The copy is opened read-write (migrations + rollup writes); never pass the live file.
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAY_MS, HOUR_MS } from '../server/usage/aggregate';
import { queryAnalytics } from '../server/usage/analytics';
import { createAnalyticsHandler } from '../server/usage/handler';
import { createRateBookLoader } from '../server/usage/rates';
import { UsageBulkJobs } from '../server/usage/bulkJobs';
import { startHourlyRollups } from '../server/usage/rollupMaintenance';
import { UsageStore, openUsageReader } from '../server/usage/store';
import { validateAnalyticsQuery } from '../server/usage/validate';
import { WriterQueue } from '../server/usage/writerQueue';

const [dbPath, ratesPath] = process.argv.slice(2);
if (!dbPath || !ratesPath || dbPath.includes('.local/share/prox-usage'))
  throw new Error('usage: bun scripts/usage-real-measure.ts <copy.sqlite> <usage-rates.json>');
const log = (value: object) => console.log(JSON.stringify(value));
const procIo = () => {
  const text = readFileSync('/proc/self/io', 'utf8');
  const get = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(text)![1]);
  return { rchar: get('rchar'), wchar: get('wchar') };
};
const fileBytes = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};
const loader = createRateBookLoader(ratesPath);
const snapshot = loader.load();
if (!snapshot.book) throw new Error(`rate book unavailable: ${snapshot.error}`);

const directory = mkdtempSync('/dev/shm/prox-real-measure-');
const keyFile = join(directory, 'key');
writeFileSync(keyFile, 'real-measure-key');
const store = new UsageStore({ events: dbPath, raw: null });
const side = new Database(dbPath); // stats and checkpoint only, WAL-safe beside the store
side.exec('PRAGMA busy_timeout=5000');
try {
  const stats = side
    .query<{ n: number; lo: number; hi: number }, []>(
      'SELECT count(*) AS n, min(ts_ms) AS lo, max(ts_ms) AS hi FROM events'
    )
    .get()!;
  log({ stage: 'copy', ...stats, dbBytes: fileBytes(dbPath), runtime: Bun.version });

  // Backfill through the production scheduler (1 s tick, one hour per governed chunk, 4 MB/s
  // default budget, real /proc/pressure/io admission).
  const queue = new WriterQueue();
  const jobs = new UsageBulkJobs(store, queue.enqueueJob.bind(queue));
  const ioBefore = procIo();
  const walBefore = fileBytes(dbPath + '-wal');
  const started = performance.now();
  const maintenance = startHourlyRollups(store, jobs, ratesPath);
  let lastLog = 0;
  for (;;) {
    await Bun.sleep(1000);
    const report = jobs.backfillReport();
    if (report.hoursCompleted - lastLog >= 60 || report.state === 'done') {
      lastLog = report.hoursCompleted;
      const io = procIo();
      log({
        stage: 'backfill-progress',
        seconds: (performance.now() - started) / 1000,
        state: report.state,
        hours: report.hoursCompleted,
        rchar: io.rchar - ioBefore.rchar,
        wchar: io.wchar - ioBefore.wchar,
        pause: report.pauseReason,
      });
    }
    if (report.state === 'failed') throw new Error(JSON.stringify(report.lastFailure));
    if (report.state === 'done') break;
  }
  const wallMs = performance.now() - started;
  await maintenance.close();
  const io = procIo();
  side.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const sizes = side
    .query<{ rows: number; bytes: number; hours: number }, []>(
      `SELECT count(*) AS rows, coalesce(sum(length(latencies) + length(ttfts)), 0) AS bytes,
        count(DISTINCT bucket) AS hours FROM usage_hour_rollup`
    )
    .get()!;
  const state = side
    .query<{ dirty: number; supported: number; n: number }, []>(
      'SELECT dirty, supported, count(*) AS n FROM usage_hour_state GROUP BY dirty, supported'
    )
    .all();
  log({
    stage: 'backfill-result',
    wallSeconds: wallMs / 1000,
    hoursCompleted: jobs.backfillReport().hoursCompleted,
    rchar: io.rchar - ioBefore.rchar,
    wchar: io.wchar - ioBefore.wchar,
    walBeforeBytes: walBefore,
    walAfterBytes: fileBytes(dbPath + '-wal'),
    dbBytes: fileBytes(dbPath),
    rollup: sizes,
    state,
    bytesPerSecondBudget: 4_000_000,
  });
  side.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  log({ stage: 'checkpointed', dbBytes: fileBytes(dbPath) });

  // Equality: one fixed clock and one reader snapshot per query, raw forced vs default.
  const now = Date.now();
  const windows: { label: string; from: number; to: number; granularity: 'day' | 'hour' }[] = [];
  for (const [days, granularity] of [
    [1, 'hour'],
    [7, 'day'],
    [7, 'hour'],
    [30, 'day'],
    [30, 'hour'],
    [31, 'day'], // The API maximum range.
    [31, 'hour'],
  ] as const)
    windows.push({
      label: `${days}d-${granularity}`,
      from: now - days * DAY_MS,
      to: now,
      granularity,
    });
  // Unaligned boundaries: partial hours at both ends, a boundary inside the range, and an
  // exact-hour range.
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (const [label, from, to] of [
    ['offset-17m', now - 30 * DAY_MS - 17 * 60_000, now - 41 * 60_000],
    ['aligned', hour - 30 * DAY_MS, hour],
    ['mid-5d', hour - 12 * DAY_MS - 1_234_567, hour - 7 * DAY_MS + 987_654],
    ['single-hour', hour - 5 * HOUR_MS, hour - 4 * HOUR_MS],
    ['sub-hour', hour - 9 * HOUR_MS + 60_000, hour - 9 * HOUR_MS + 1_800_000],
  ] as const)
    for (const granularity of ['day', 'hour'] as const)
      windows.push({ label: `${label}-${granularity}`, from, to, granularity });
  const reader = openUsageReader(dbPath);
  let identical = 0;
  const mismatches: string[] = [];
  try {
    for (const window of windows) {
      const base = {
        from_ms: window.from,
        to_ms: window.to,
        time_zone: 'UTC',
        granularity: window.granularity,
        outcome: 'all',
        limit: 100,
      };
      const run = (forceRaw: boolean) =>
        JSON.stringify(
          queryAnalytics(
            reader,
            validateAnalyticsQuery({ ...base, ...(forceRaw ? { debug_force_raw: true } : {}) }),
            snapshot,
            { now: () => now }
          )
        );
      const rollup = run(false);
      const raw = run(true);
      const equal = rollup === raw;
      if (equal) identical += 1;
      else mismatches.push(window.label);
      const parsed = JSON.parse(raw);
      log({
        stage: 'equality',
        window: window.label,
        equal,
        calls: parsed.summary.calls,
        bytes: raw.length,
      });
    }
  } finally {
    reader.close();
  }
  log({ stage: 'equality-result', windows: windows.length, identical, mismatches });

  // Latency through the production handler and worker: raw forced vs default (rollup).
  const handler = createAnalyticsHandler({
    dbPath,
    keyFile,
    rateBook: { load: () => snapshot },
  });
  try {
    const request = (days: number, granularity: 'day' | 'hour', forceRaw: boolean) =>
      new Request('http://127.0.0.1/v1/analytics', {
        method: 'POST',
        headers: { authorization: 'Bearer real-measure-key' },
        body: JSON.stringify({
          from_ms: now - days * DAY_MS,
          to_ms: now,
          time_zone: 'UTC',
          granularity,
          outcome: 'all',
          limit: 100,
          ...(forceRaw ? { debug_force_raw: true } : {}),
        }),
      });
    for (const [days, granularity] of [
      [1, 'hour'],
      [30, 'day'],
      [30, 'hour'],
    ] as const) {
      for (const forceRaw of [true, false]) {
        const durations: number[] = [];
        for (let run = 0; run < 53; run += 1) {
          const at = performance.now();
          const response = await handler(request(days, granularity, forceRaw));
          if (response.status !== 200) throw new Error(await response.text());
          await response.text();
          if (run >= 3) durations.push(performance.now() - at);
        }
        durations.sort((a, b) => a - b);
        log({
          stage: 'latency',
          real: true,
          path: forceRaw ? 'raw' : 'rollup',
          days,
          granularity,
          warmRuns: 50,
          p50_ms: durations[24],
          p95_ms: durations[47],
          max_ms: durations[49],
        });
      }
    }
  } finally {
    handler.close();
  }
} finally {
  side.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
