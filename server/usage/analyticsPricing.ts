// CPAMP's per-view pricing projections and combination order, after the unchanged SQL grouping.
import type { AnalyticsCost } from '../../src/domain/analytics/types';
import { aggregateEstimate } from './parity';
import { combineEstimates, estimateAggregateCost, resolveModelPrice } from './pricing';
import type { RateBook } from './rates';
import { eventTokens, type TokenRow } from './search';
import { RECORD_KIND, type EventTokens } from './types';

export interface AggregatePricingRow extends TokenRow {
  bucket: number;
  provider_id: number;
  model_id: number;
  billing_model_id: number;
  requested_model_id: number;
  tier_id: number;
  band: number | null;
  calls: number;
}
export interface PricingOrderKey {
  model: string;
  billingModel: string;
  pricingModel: string;
  tier: string;
  band: number | null;
}
// Go strings and SQLite BINARY both compare UTF-8 bytes, rather than JavaScript UTF-16 units.
const compareText = (left: string, right: string) =>
  left === right ? 0 : Buffer.compare(Buffer.from(left), Buffer.from(right));
function pricingModelCompare(left: PricingOrderKey, right: PricingOrderKey): number {
  return (
    compareText(left.model, right.model) ||
    compareText(left.billingModel, right.billingModel) ||
    compareText(left.pricingModel, right.pricingModel)
  );
}
/** Exact port of monitoring/prox.go pricingRowLess, expressed as a stable-sort comparator. */
export function pricingRowCompare(left: PricingOrderKey, right: PricingOrderKey): number {
  return (
    pricingModelCompare(left, right) ||
    compareText(left.tier, right.tier) ||
    (left.band ?? -1) - (right.band ?? -1)
  );
}
interface PricingRow extends PricingOrderKey {
  requestedModel: string;
  modelId: number;
  providerId: number;
  bucket: number;
  calls: number;
  tokens: EventTokens;
}
function fold(map: Map<string, PricingRow>, row: PricingRow, scope: number | null) {
  // CPAMP model stats omit bucket/provider, timeline adds bucket, provider stats add provider.
  // Event flags, kind and outcome remain in SQL; these pricing projections carry only sums.
  const key = JSON.stringify([
    scope,
    row.model,
    row.billingModel,
    row.pricingModel,
    row.band,
    row.tier,
  ]);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...row, tokens: { ...row.tokens } });
    return;
  }
  existing.calls += row.calls;
  for (const key of Object.keys(row.tokens) as (keyof EventTokens)[])
    existing.tokens[key] += row.tokens[key];
}
function add(map: Map<number, AnalyticsCost>, key: number, cost: AnalyticsCost) {
  map.set(
    key,
    combineEstimates(map.get(key) ?? { usd: null, status: 'unpriced', reasons: [] }, cost)
  );
}
export function analyticsCosts(
  rows: readonly AggregatePricingRow[],
  names: ReadonlyMap<number, string>,
  book: RateBook
) {
  const stats = new Map<string, PricingRow>();
  const timeline = new Map<string, PricingRow>();
  const providerStats = new Map<string, PricingRow>();
  const modelProviders = new Map<number, Set<number>>();
  for (const row of rows) {
    const model = names.get(row.model_id)!;
    const billingModel = names.get(row.billing_model_id)!;
    const requestedModel = names.get(row.requested_model_id)!;
    const pricing: PricingRow = {
      model,
      billingModel,
      requestedModel,
      pricingModel:
        resolveModelPrice([billingModel, model, requestedModel], book)?.matchedModel ??
        billingModel,
      tier: names.get(row.tier_id)!,
      band: row.band,
      calls: row.calls,
      modelId: row.model_id,
      providerId: row.provider_id,
      bucket: row.bucket,
      tokens: eventTokens(row),
    };
    fold(stats, pricing, null);
    fold(timeline, pricing, row.bucket);
    fold(providerStats, pricing, row.provider_id);
    const providers = modelProviders.get(row.model_id) ?? new Set<number>();
    providers.add(row.provider_id);
    modelProviders.set(row.model_id, providers);
  }
  const estimate = (row: PricingRow) =>
    aggregateEstimate(
      estimateAggregateCost(
        {
          ...row,
          usageFlags: 0,
          recordKind: RECORD_KIND.execution,
          contextThreshold: row.band,
        },
        book
      )
    );
  const sortedStats = [...stats.values()].sort(
    (left, right) => right.calls - left.calls || pricingRowCompare(left, right)
  );
  let summary: AnalyticsCost = {
    usd: null,
    status: 'unavailable',
    reasons: ['no-retained-events'],
  };
  const models = new Map<number, AnalyticsCost>();
  const providers = new Map<number, AnalyticsCost>();
  const buckets = new Map<number, AnalyticsCost>();
  const regroupProviders = [...modelProviders.values()].every((set) => set.size === 1);
  for (const row of sortedStats) {
    const cost = estimate(row);
    summary = combineEstimates(
      models.size ? summary : { usd: null, status: 'unpriced', reasons: [] },
      cost
    );
    add(models, row.modelId, cost);
    if (regroupProviders) add(providers, row.providerId, cost);
  }
  for (const row of [...timeline.values()].sort(
    (left, right) => left.bucket - right.bucket || pricingRowCompare(left, right)
  ))
    add(buckets, row.bucket, estimate(row));
  if (!regroupProviders) {
    // The fallback is ProviderModelStatsWithFilter: calls DESC, ties in its SQL GROUP BY
    // key order (band before tier). prox.go does not re-sort that repository result.
    const sortedProviders = [...providerStats.values()].sort(
      (left, right) =>
        right.calls - left.calls ||
        pricingModelCompare(left, right) ||
        (left.band ?? -1) - (right.band ?? -1) ||
        compareText(left.tier, right.tier) ||
        compareText(names.get(left.providerId)!, names.get(right.providerId)!)
    );
    for (const row of sortedProviders) add(providers, row.providerId, estimate(row));
  }
  return { summary, models, providers, buckets };
}
