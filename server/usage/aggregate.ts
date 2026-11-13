// Shared SQL aggregation contract: preserve every pricing dimension before summation.
import type { Dimension } from './search';
import type { AggregatePricingRow } from './analyticsPricing';
import type { RecordKindCode } from './types';
import type { RateBook } from './rates';
import type { Database } from 'bun:sqlite';
import type { QueryFilter } from './search';
import { createHash } from 'node:crypto';

export interface AggregateRow extends AggregatePricingRow {
  usage_flags: number;
  record_kind: RecordKindCode;
  failures: number;
  failed: number;
  latency_sum: number;
  latency_count: number;
}
/** Values are dictionary ids and validated integer thresholds, never interpolated text.
 * Each candidate CASE returns -1 for a configured base-only model: it must stop fallback.
 * Thresholds are tested descending so each event gets the largest STRICTLY exceeded band.
 */
export function contextBandSql(dims: readonly Dimension[], book: RateBook): string {
  const rated = dims.filter(
    (d) => d.kind === 'model' && Object.prototype.hasOwnProperty.call(book.models, d.value)
  );
  if (!rated.length) return 'NULL';
  const candidate = (column: string) =>
    `CASE e.${column} ${rated
      .map((d) => {
        const tiers = book.models[d.value].context_tiers;
        const band = tiers.length
          ? `CASE ${[...tiers]
              .reverse()
              .map(
                (tier) =>
                  `WHEN e.input_total > ${tier.above_input_tokens} THEN ${tier.above_input_tokens}`
              )
              .join(' ')} ELSE -1 END`
          : '-1';
        return `WHEN ${d.id} THEN ${band}`;
      })
      .join(' ')} END`;
  return `nullif(coalesce(${['billing_model_id', 'model_id', 'requested_model_id'].map(candidate).join(', ')}), -1)`;
}
export const tokenColumns = [
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'output_total',
  'reasoning',
  'total',
] as const;

export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;
export const groupDimensions = [
  'provider_id',
  'model_id',
  'billing_model_id',
  'requested_model_id',
  'tier_id',
  'band',
  'usage_flags',
  'record_kind',
  'failed',
] as const;
export const sumColumns = [
  ...tokenColumns,
  'calls',
  'failures',
  'latency_sum',
  'latency_count',
] as const;
// Finish P5's sort with the remaining dimensions, so floating-point cost addition and reason
// order are identical after raw/rollup groups have been merged.
export const aggregateOrder = [
  'bucket',
  'model_id',
  'billing_model_id',
  'tier_id',
  'band',
  'usage_flags',
  'record_kind',
  'failed',
  'provider_id',
  'requested_model_id',
] as const;
export function compareAggregates(a: AggregateRow, b: AggregateRow): number {
  for (const key of aggregateOrder) {
    const delta = (a[key] ?? -1) - (b[key] ?? -1);
    if (delta) return delta;
  }
  return 0;
}
export function aggregateKey(row: AggregateRow): string {
  let key = String(row.bucket);
  for (const dimension of groupDimensions) key += ',' + (row[dimension] ?? '');
  return key;
}
export function readAggregates(
  db: Database,
  filter: QueryFilter,
  dims: readonly Dimension[],
  book: RateBook,
  bucketSize: number
): AggregateRow[] {
  return db
    .query<AggregateRow, (number | string)[]>(
      `
    SELECT (e.ts_ms / ${bucketSize}) * ${bucketSize} AS bucket,
      e.provider_id, e.model_id, e.billing_model_id, e.requested_model_id, e.tier_id,
      ${contextBandSql(dims, book)} AS band, e.usage_flags, e.record_kind, e.failed,
      count(*) AS calls, sum(e.failed) AS failures,
      ${tokenColumns.map((key) => `sum(e.${key}) AS ${key}`).join(', ')},
      coalesce(sum(e.latency_ms), 0) AS latency_sum, count(e.latency_ms) AS latency_count
    FROM events e WHERE ${filter.sql}
    GROUP BY bucket, ${groupDimensions.join(', ')}
    ORDER BY ${aggregateOrder.join(', ')}
  `
    )
    .all(...filter.args);
}
/** Only model membership and thresholds affect grouping. Rates and metadata never do. */
export function bandLayout(book: RateBook): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(book.models)
          .sort()
          .map((name) => [
            name,
            book.models[name].context_tiers.map((tier) => tier.above_input_tokens),
          ])
      )
    )
    .digest('hex');
}
