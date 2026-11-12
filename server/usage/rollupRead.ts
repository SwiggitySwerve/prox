// Snapshot read planning: use only whole, closed, clean hours under the current band layout.
import type { Database } from 'bun:sqlite';
import {
  aggregateKey,
  bandLayout,
  compareAggregates,
  groupDimensions,
  HOUR_MS,
  readAggregates,
  sumColumns,
  type AggregateRow,
} from './aggregate';
import { RECORD_KIND } from './types';
import { readCoverage, type CoverageRow } from './coverage';
import { LatencyGroups } from './latency';
import type { RateBook } from './rates';
import type { Dimension, QueryFilter } from './search';
import type { UsageAnalyticsQuery } from './validate';

export function canReadRollup(q: UsageAnalyticsQuery): boolean {
  return (
    !q.debug_force_raw &&
    !q.search?.trim() &&
    !q.provider?.trim() &&
    !q.model?.trim() &&
    q.outcome === 'all'
  );
}
interface StoredSamples {
  sample_bucket: number;
  model_id: number;
  provider_id: number;
  latencies: Uint8Array;
  ttfts: Uint8Array;
}
/** Bun's blob offsets need not be int32 aligned. Copy only when alignment requires it. */
function samples(blob: Uint8Array): Int32Array {
  if (blob.byteOffset % 4) blob = new Uint8Array(blob);
  return new Int32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
export function readAnalyticsGroups(
  db: Database,
  q: UsageAnalyticsQuery,
  filter: QueryFilter,
  dims: readonly Dimension[],
  book: RateBook,
  bucketSize: number,
  nowMs: number,
  check: () => void,
  onPhase?: (phase: string) => void,
  afterAggregate?: () => void
) {
  const latency = new LatencyGroups();
  const rows: AggregateRow[] = [];
  const coverageRows: CoverageRow[] = [];
  let readStoredSamples: (() => void) | undefined;
  let spans = [{ from: q.from_ms, to: q.to_ms }];
  if (canReadRollup(q)) {
    const first = Math.ceil(q.from_ms / HOUR_MS) * HOUR_MS;
    const end = Math.min(Math.floor(q.to_ms / HOUR_MS), Math.floor(nowMs / HOUR_MS)) * HOUR_MS;
    const layout = bandLayout(book);
    const clean = new Set(
      db
        .query<{ hour_ms: number }, [number, number, string]>(
          `
      SELECT hour_ms FROM usage_hour_state WHERE hour_ms >= ? AND hour_ms < ?
        AND dirty = 0 AND supported = 1 AND layout = ?
    `
        )
        .all(first, end, layout)
        .map((row) => row.hour_ms)
    );
    if (clean.size) {
      spans = [];
      let from = q.from_ms;
      for (let hour = first; hour < end; hour += HOUR_MS) {
        if (!clean.has(hour)) continue;
        if (hour > from) spans.push({ from, to: hour });
        from = hour + HOUR_MS;
      }
      if (from < q.to_ms) spans.push({ from, to: q.to_ms });
      const hours = [...clean];
      const hourSlots = hours.map(() => '?').join(',');
      const source = `FROM usage_hour_rollup r WHERE r.bucket IN (${hourSlots})
        AND r.record_kind != ${RECORD_KIND.supplementary}`;
      coverageRows.push(
        ...db
          .query<CoverageRow, number[]>(
            `
        SELECT provider_id, max(imported) AS imported FROM usage_hour_coverage
        WHERE hour_ms IN (${hourSlots}) GROUP BY provider_id
      `
          )
          .all(...hours)
      );
      let scanned = 0;
      const rollupRows = db
        .query<AggregateRow, number[]>(
          `
        SELECT r.bucket, ${[...groupDimensions, ...sumColumns].map((key) => `r.${key}`).join(', ')}
        ${source}
      `
        )
        .all(...hours);
      onPhase?.('rollup-select');
      for (const row of rollupRows) {
        row.bucket = Math.floor(row.bucket / bucketSize) * bucketSize;
        row.band = row.band === -1 ? null : row.band;
        rows.push(row);
        if ((++scanned & 4095) === 0) check();
      }
      // Concatenate stored int32 bytes inside SQLite, then cast back to BLOB before Bun
      // sees the value. No JS text conversion occurs; NUL and invalid UTF-8 bytes survive.
      // Percentiles need bucket/model/provider only, so merge across the pricing dimensions.
      readStoredSamples = () => {
        for (const row of db
          .query<StoredSamples, number[]>(
            `
        SELECT (r.bucket / ${bucketSize}) * ${bucketSize} AS sample_bucket,
          r.model_id, r.provider_id,
          CAST(group_concat(r.latencies, '') AS BLOB) AS latencies,
          CAST(group_concat(r.ttfts, '') AS BLOB) AS ttfts
        ${source}
        GROUP BY sample_bucket, r.model_id, r.provider_id
      `
          )
          .all(...hours)) {
          latency.addSamples(
            row.sample_bucket,
            row.model_id,
            row.provider_id,
            samples(row.latencies),
            samples(row.ttfts)
          );
          if ((++scanned & 4095) === 0) check();
        }
      };
    }
  }
  // Keep all existing filter guards, changing only the range in the first two bind slots.
  const rawFilters = spans.map((span) => ({
    sql: filter.sql,
    args: [span.from, span.to, ...filter.args.slice(2)],
  }));
  for (const raw of rawFilters)
    for (const row of readAggregates(db, raw, dims, book, bucketSize)) rows.push(row);
  afterAggregate?.();
  readStoredSamples?.();
  onPhase?.('rollup-read');
  for (const raw of rawFilters) {
    const select = db.query<
      {
        bucket: number;
        model_id: number;
        provider_id: number;
        latency_ms: number | null;
        ttft_ms: number | null;
      },
      (number | string)[]
    >(`
      SELECT (e.ts_ms / ${bucketSize}) * ${bucketSize} AS bucket, e.model_id, e.provider_id,
        e.latency_ms, e.ttft_ms FROM events e WHERE ${raw.sql}
    `);
    let scanned = 0;
    for (const row of select.iterate(...raw.args)) {
      latency.add(row.bucket, row.model_id, row.provider_id, row.latency_ms, row.ttft_ms);
      if ((++scanned & 4095) === 0) check();
    }
    coverageRows.push(...readCoverage(db, Number(raw.args[0]), Number(raw.args[1])));
    check();
  }
  onPhase?.('raw-read');
  // Price the exact same groups as raw SQL, once, after merging integer sums. Pricing each
  // hour separately would change floats, priced-call statuses and the first-seen reason order.
  // Whole clean hours and raw spans are disjoint. Hourly groups cannot overlap, so
  // concatenation already merges them; daily groups still need integer addition.
  if (bucketSize === HOUR_MS) {
    rows.sort(compareAggregates);
    onPhase?.('merge');
    return { rows, latency, coverageRows };
  }
  const merged = new Map<string, AggregateRow>();
  for (const row of rows) {
    const key = aggregateKey(row);
    const prior = merged.get(key);
    if (prior) for (const column of sumColumns) prior[column] += row[column];
    else merged.set(key, row);
  }
  const result = { rows: [...merged.values()].sort(compareAggregates), latency, coverageRows };
  onPhase?.('merge');
  return result;
}
