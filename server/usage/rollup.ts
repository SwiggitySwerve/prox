// Writer-side whole-hour replacement. The caller owns the sole write connection and queue.
import { readCoverage } from './coverage';
import type { Database } from 'bun:sqlite';
import {
  aggregateKey,
  bandLayout,
  contextBandSql,
  groupDimensions,
  HOUR_MS,
  readAggregates,
  sumColumns,
  type AggregateRow,
} from './aggregate';
import type { RateBook } from './rates';
import type { Dimension } from './search';

export interface RollupWriteResult {
  hour: number;
  rows: number;
  sampleBytes: number;
  supported: boolean;
}
/** One closed hour, in one transaction. Oversize timings stay raw rather than wrapping int32. */
export function rebuildHour(
  db: Database,
  hour: number,
  book: RateBook,
  nowMs: number
): RollupWriteResult {
  if (!Number.isSafeInteger(hour) || hour % HOUR_MS || hour + HOUR_MS > nowMs)
    throw new Error('Rollup requires a closed UTC hour');
  return db
    .transaction(() => {
      const dims = db.query<Dimension, []>('SELECT id, kind, value FROM dim').all();
      const filter = { sql: 'e.ts_ms >= ? AND e.ts_ms < ?', args: [hour, hour + HOUR_MS] };
      const rows = readAggregates(db, filter, dims, book, HOUR_MS);
      const samples = new Map(
        rows.map((row) => [aggregateKey(row), { latency: [] as number[], ttft: [] as number[] }])
      );
      let supported = true;
      for (const row of db
        .query<AggregateRow & { latency_ms: number | null; ttft_ms: number | null }, number[]>(
          `
      SELECT ${hour} AS bucket, provider_id, model_id, billing_model_id, requested_model_id,
        tier_id, ${contextBandSql(dims, book)} AS band, usage_flags, record_kind, failed,
        latency_ms, ttft_ms FROM events e WHERE ${filter.sql}
    `
        )
        .iterate(...filter.args)) {
        const pair = samples.get(aggregateKey(row))!;
        for (const [value, values] of [
          [row.latency_ms, pair.latency],
          [row.ttft_ms, pair.ttft],
        ] as const) {
          if (value === null || value <= 0) continue;
          if (!Number.isInteger(value) || value > 2147483647) supported = false;
          values.push(value);
        }
      }
      db.query('DELETE FROM usage_hour_coverage WHERE hour_ms = ?').run(hour);
      const insertCoverage = db.query('INSERT INTO usage_hour_coverage VALUES (?, ?, ?)');
      for (const row of readCoverage(db, hour, hour + HOUR_MS))
        insertCoverage.run(hour, row.provider_id, row.imported);
      db.query('DELETE FROM usage_hour_rollup WHERE bucket = ?').run(hour);
      let sampleBytes = 0;
      if (supported) {
        const columns = ['bucket', ...groupDimensions, ...sumColumns, 'latencies', 'ttfts'];
        const insert = db.query(
          `INSERT INTO usage_hour_rollup (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        );
        for (const row of rows) {
          const pair = samples.get(aggregateKey(row))!;
          const latencies = new Int32Array(pair.latency.sort((a, b) => a - b));
          const ttfts = new Int32Array(pair.ttft.sort((a, b) => a - b));
          sampleBytes += latencies.byteLength + ttfts.byteLength;
          insert.run(
            hour,
            ...groupDimensions.map((key) => row[key] ?? -1),
            ...sumColumns.map((key) => row[key]),
            new Uint8Array(latencies.buffer),
            new Uint8Array(ttfts.buffer)
          );
        }
      }
      db.query(
        `INSERT INTO usage_hour_state (hour_ms, layout, dirty, supported) VALUES (?, ?, 0, ?)
      ON CONFLICT (hour_ms) DO UPDATE SET layout = excluded.layout, dirty = 0, supported = excluded.supported`
      ).run(hour, bandLayout(book), supported ? 1 : 0);
      return { hour, rows: supported ? rows.length : 0, sampleBytes, supported };
    })
    .immediate();
}

/** No unbounded DISTINCT/backfill on startup: seek one old hour per job by the events PK.
 * New/late/imported inserts mark their own hours, even behind the discovery cursor.
 */
export function rebuildNextHour(
  db: Database,
  book: RateBook,
  nowMs: number
): RollupWriteResult | null {
  const closed = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const dirty = db
    .query<{ hour_ms: number }, [number, string]>(
      `
    SELECT hour_ms FROM usage_hour_state WHERE hour_ms < ? AND (dirty = 1 OR layout != ?)
    ORDER BY hour_ms LIMIT 1
  `
    )
    .get(closed, bandLayout(book));
  if (dirty) return rebuildHour(db, dirty.hour_ms, book, nowMs);
  const cursor = Number(
    db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'rollup:discovery_ms'")
      .get()?.value ?? 0
  );
  const next = db
    .query<{ ts_ms: number }, [number, number]>(
      'SELECT ts_ms FROM events WHERE ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms LIMIT 1'
    )
    .get(cursor, closed);
  if (!next) return null;
  const hour = Math.floor(next.ts_ms / HOUR_MS) * HOUR_MS;
  // Advance only after a successful replacement; a crash can safely repeat an hour.
  const state = db
    .query<{ dirty: number; layout: string }, [number]>(
      'SELECT dirty, layout FROM usage_hour_state WHERE hour_ms = ?'
    )
    .get(hour);
  const result =
    state?.dirty === 0 && state.layout === bandLayout(book)
      ? { hour, rows: 0, sampleBytes: 0, supported: true }
      : rebuildHour(db, hour, book, nowMs);
  db.query(
    `INSERT INTO meta (key, value) VALUES ('rollup:discovery_ms', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  ).run(String(hour + HOUR_MS));
  return result;
}
