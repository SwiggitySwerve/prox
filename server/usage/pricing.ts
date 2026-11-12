// Pure pricing owner: current configured rates applied to integer token groups.
import type {
  AnalyticsCost,
  AnalyticsModelRate,
  RegisteredAnalyticsModel,
} from '../../src/domain/analytics/types';
import { applyRateOverride, type ModelRate, type RateBook, type RateValues } from './rates';
import { RECORD_KIND, USAGE_FLAG, type EventTokens, type RecordKindCode } from './types';

export interface PricingGroup {
  billingModel?: string | null;
  model: string;
  requestedModel?: string | null;
  tier?: string;
  tokens: EventTokens;
  usageFlags: number;
  recordKind: RecordKindCode;
  calls?: number;
  /** Override only when presence was separately retained; absent means derive from flags. */
  usagePresent?: boolean | null;
  /** P5 must pass the per-event band after SQL summation. Null is the base band.
   * Undefined classifies a single event using inputTotal, never an aggregate's size. */
  contextThreshold?: number | null;
}

export function resolveModelPrice(names: readonly (string | null | undefined)[], book: RateBook) {
  for (const name of names) {
    const candidate = name?.trim();
    if (candidate && Object.prototype.hasOwnProperty.call(book.models, candidate)) {
      return { matchedModel: candidate, price: book.models[candidate] };
    }
  }
  return null;
}

export function contextBand(price: ModelRate, inputTotal: number): number | null {
  let band: number | null = null;
  for (const row of price.context_tiers) {
    if (inputTotal > row.above_input_tokens) band = row.above_input_tokens;
  }
  return band;
}
function serviceRate(price: ModelRate, tier: string) {
  const name = tier.trim().toLowerCase();
  return price.service_tiers.find((row) => row.names.includes(name));
}
function effectiveRates(price: ModelRate, band: number | null, tier: string): RateValues {
  const context = price.context_tiers.find((row) => row.above_input_tokens === band);
  if (band !== null && !context)
    throw new Error(`Unknown context band ${band}; regroup with current rates`);
  const override = context ?? serviceRate(price, tier);
  return override ? applyRateOverride(price, override) : price;
}
const COMPONENT_FLAGS =
  USAGE_FLAG.inputTokens |
  USAGE_FLAG.outputTokens |
  USAGE_FLAG.cacheReadTokens |
  USAGE_FLAG.cacheCreationTokens;

export function estimateCost(group: PricingGroup, book: RateBook): AnalyticsCost {
  const calls = group.calls ?? 1;
  for (const [key, value] of Object.entries({ ...group.tokens, calls })) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`${key} must be a non-negative safe integer`);
  }
  if (calls === 0) return { usd: null, status: 'unavailable', reasons: ['no-retained-events'] };
  const result: AnalyticsCost = {
    usd: null,
    status: 'unpriced',
    reasons: [],
    unpriced_calls: calls,
  };
  const tokens = group.tokens;
  const present =
    group.usagePresent === undefined
      ? group.usageFlags & USAGE_FLAG.presenceReported
        ? true
        : null
      : group.usagePresent;
  if (present === false) {
    result.status = 'unavailable';
    result.reasons.push('usage-not-reported');
  } else if (
    present === null &&
    !tokens.inputTotal &&
    !tokens.outputTotal &&
    !tokens.cacheRead &&
    !tokens.cacheWrite
  ) {
    result.status = 'unavailable';
    result.reasons.push('usage-presence-unknown');
  } else {
    const resolved = resolveModelPrice(
      [group.billingModel, group.model, group.requestedModel],
      book
    );
    if (!resolved) result.reasons.push('model-rate-unavailable');
    else {
      const price = resolved.price;
      const band =
        group.contextThreshold === undefined
          ? contextBand(price, tokens.inputTotal)
          : group.contextThreshold;
      if (calls > 1 && price.context_tiers.length && group.contextThreshold === undefined) {
        throw new Error('Aggregate pricing requires an explicit per-event context band');
      }
      const tier = group.tier ?? '';
      const effective = effectiveRates(price, band, tier);
      // CPAMP does not count a cache-write-only row as a configured model price.
      if (effective.input === null && effective.output === null && effective.cache_read === null) {
        result.reasons.push('model-rates-not-configured');
      } else {
        if (present === null) result.reasons.push('usage-presence-unknown');
        // Raw counters remain raw when bit 7 is clear. Do not infer provider cache semantics.
        if (effective.input === null && tokens.inputTotal > tokens.cacheRead)
          result.reasons.push('input-rate-unavailable');
        if (effective.output === null && tokens.outputTotal > 0)
          result.reasons.push('output-rate-unavailable');
        if (effective.cache_read === null && tokens.cacheRead > 0)
          result.reasons.push('cache-read-rate-unavailable');
        const name = tier.trim().toLowerCase();
        if (name && name !== 'default' && name !== 'standard' && !serviceRate(price, tier)) {
          result.reasons.push('service-tier-rate-not-explicit');
        }
        result.usd =
          (tokens.inputUncached * (effective.input ?? 0)) / 1_000_000 +
          (tokens.cacheRead * (effective.cache_read ?? 0)) / 1_000_000 +
          (tokens.cacheWrite * (effective.cache_write ?? effective.input ?? 0)) / 1_000_000 +
          (tokens.outputTotal * (effective.output ?? 0)) / 1_000_000;
        result.status = result.reasons.length
          ? 'partial'
          : result.usd === 0 && effective.input === 0 && effective.output === 0
            ? 'explicit-zero'
            : 'estimated';
        result.priced_calls = calls;
        delete result.unpriced_calls;
      }
    }
  }
  if (
    result.usd !== null &&
    (!(group.usageFlags & USAGE_FLAG.breakdownComplete) ||
      !(group.usageFlags & USAGE_FLAG.fieldsPresent) ||
      (group.usageFlags & COMPONENT_FLAGS) !== COMPONENT_FLAGS)
  ) {
    result.status = 'partial';
    result.reasons.push('usage-components-unreported');
  }
  if (group.recordKind === RECORD_KIND.unknown) {
    result.reasons.push('legacy-record-kind-unknown');
    if (result.usd !== null) result.status = 'partial';
  } else if (group.recordKind === RECORD_KIND.supplementary && result.usd !== null) {
    result.status = 'partial';
    result.reasons.push('supplementary-overlap-unknown');
  }
  return result;
}

/** Preserve known subtotals, unique reasons in first-seen order, and call counts. */
export function combineEstimates(left: AnalyticsCost, right: AnalyticsCost): AnalyticsCost {
  const reasons = [...new Set([...left.reasons, ...right.reasons])];
  const usd = left.usd === null && right.usd === null ? null : (left.usd ?? 0) + (right.usd ?? 0);
  const priced = (left.priced_calls ?? 0) + (right.priced_calls ?? 0);
  const unpriced = (left.unpriced_calls ?? 0) + (right.unpriced_calls ?? 0);
  return {
    usd,
    status: usd === null ? 'unpriced' : reasons.length || unpriced ? 'partial' : 'estimated',
    reasons,
    ...(priced ? { priced_calls: priced } : {}),
    ...(unpriced ? { unpriced_calls: unpriced } : {}),
  };
}

function analyticsRate(
  entry: RegisteredAnalyticsModel,
  registered: boolean,
  book: RateBook
): AnalyticsModelRate {
  const result: AnalyticsModelRate = {
    ...entry,
    registered,
    matched_model: null,
    status: 'unpriced',
    source: 'unavailable',
    input_per_million: null,
    output_per_million: null,
    cache_read_per_million: null,
    cache_write_per_million: null,
    updated_at_ms: null,
    context_tiers: [],
    service_tiers: [],
  };
  const resolved = resolveModelPrice([entry.id], book);
  if (!resolved) return result;
  const price = resolved.price;
  result.matched_model = resolved.matchedModel;
  result.input_per_million = price.input;
  result.output_per_million = price.output;
  result.cache_read_per_million = price.cache_read;
  result.cache_write_per_million = price.cache_write;
  if (price.input !== null && price.output !== null) result.status = 'priced';
  result.source = price.source?.trim() || 'configured-or-owner-fallback';
  result.updated_at_ms = price.updated_at_ms || null;
  result.context_tiers = price.context_tiers.map((row) => {
    const effective = applyRateOverride(price, row);
    return {
      above_input_tokens: row.above_input_tokens,
      input_per_million: effective.input,
      output_per_million: effective.output,
    };
  });
  result.service_tiers = price.service_tiers.map((row) => {
    const effective = applyRateOverride(price, row);
    return {
      name: row.names[row.names.length - 1],
      input_per_million: effective.input,
      output_per_million: effective.output,
    };
  });
  return result;
}

/** Catalog order is preserved, then unregistered provider/model pairs in lexical order. */
export function buildRateInventory(
  catalog: readonly RegisteredAnalyticsModel[],
  observed: readonly Pick<RegisteredAnalyticsModel, 'provider' | 'id'>[],
  book: RateBook
): AnalyticsModelRate[] {
  const remaining = new Map(
    observed.map((entry) => [
      `${entry.provider}\0${entry.id}`,
      { ...entry, instance_id: '', instance_label: '' },
    ])
  );
  const seen = new Set<string>();
  const result: AnalyticsModelRate[] = [];
  for (const entry of catalog) {
    const key = `${entry.instance_id}\0${entry.provider}\0${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(analyticsRate(entry, true, book));
    remaining.delete(`${entry.provider}\0${entry.id}`);
  }
  for (const key of [...remaining.keys()].sort())
    result.push(analyticsRate(remaining.get(key)!, false, book));
  return result;
}
