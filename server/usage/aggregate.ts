// Shared SQL aggregation contract: preserve every pricing dimension before summation.
import type { TokenRow, Dimension } from './search';
import type { RecordKindCode } from './types';
import type { RateBook } from './rates';

export interface AggregateRow extends TokenRow {
  bucket: number;
  provider_id: number;
  model_id: number;
  billing_model_id: number;
  requested_model_id: number;
  tier_id: number;
  band: number | null;
  usage_flags: number;
  record_kind: RecordKindCode;
  calls: number;
  failures: number;
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
