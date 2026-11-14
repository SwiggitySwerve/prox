// The frozen response normalization and explicit, counted exception rules.
import { coverageDifference } from './coverage';
import type { AnalyticsResponse } from '../../src/domain/analytics/types';

export const D5_MODELS = ['claude-fable-5-2', 'gpt-6.1-terra'] as const;
export const KNOWN_RESPONSE_RULES = [
  'd5-pricing',
  'detail-trace',
  'detail-provider',
  'coverage-limitations',
  'search-cpamp-only',
] as const;
export type DifferenceClass =
  | 'unexplained'
  | 'd5-pricing'
  | 'detail-provider'
  | 'detail-trace'
  | 'coverage-limitations'
  | 'search-cpamp-only'
  | 'drained-during-cpamp-outage'
  | 'ingest-gap'
  | 'ttft-zero-null';
export interface Difference {
  class: DifferenceClass;
  path: string;
  cpamp: unknown;
  prox: unknown;
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Relative tolerance only at cost.usd (1e-9) and average_latency_ms (1e-12). In particular
 * zero has no absolute epsilon. Prox returns the correctly rounded mean of integer latency
 * sums (verified against exact rationals); CPAMP's mean is occasionally one ulp (about 2e-16
 * relative) away from it. 1e-12 is four orders above one ulp and far below any count or
 * latency difference, which are whole milliseconds on at least one sample.
 */
const TOLERANCE: [suffix: string, relative: number][] = [
  ['.cost.usd', 1e-9],
  ['.average_latency_ms', 1e-12],
];
export function equalValue(a: unknown, b: unknown, path: string): boolean {
  if (a === b) return true;
  const rule = TOLERANCE.find(([suffix]) => path.endsWith(suffix));
  return (
    !!rule &&
    typeof a === 'number' &&
    typeof b === 'number' &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= rule[1] * Math.max(Math.abs(a), Math.abs(b))
  );
}
const SEARCH_FIELD_ITEM_KEYS = ['fail_summary', 'header_trace_id', 'auth_file_snapshot'] as const;
export function normalizeResponse(response: AnalyticsResponse): JsonObject {
  const value = structuredClone(response) as unknown as JsonObject;
  delete value.generated_at_ms;
  const coverage = value.coverage as JsonObject;
  delete coverage.price_revision;
  const requests = value.requests as JsonObject;
  delete requests.next_before_id;
  const items = requests.items as JsonObject[];
  items.forEach((item) => {
    delete item.id;
    // CPAMP's Prox-shaped response has no members for these three, so a response comparison has
    // nothing to compare; the event comparison (events.ts) compares the stored values.
    for (const key of SEARCH_FIELD_ITEM_KEYS) delete item[key];
  });
  // Only reorder within an equal-timestamp run. Keep every other array/order significant.
  for (let first = 0; first < items.length;) {
    let end = first + 1;
    while (end < items.length && items[end].timestamp_ms === items[first].timestamp_ms) end++;
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (object(value))
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        );
      return value;
    };
    const identity = (item: JsonObject) =>
      JSON.stringify(
        canonical(
          Object.fromEntries(
            Object.entries(item).filter(([key]) => !['provider', 'trace_id', 'cost'].includes(key))
          )
        )
      );
    items.splice(
      first,
      end - first,
      ...items.slice(first, end).sort((a, b) => identity(a).localeCompare(identity(b), 'en'))
    );
    first = end;
  }
  return value;
}
export function diffValues(a: unknown, b: unknown, path = '$'): Difference[] {
  if (equalValue(a, b, path)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const result: Difference[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      result.push(...diffValues(a[i], b[i], `${path}[${i}]`));
    return result;
  }
  if (object(a) && object(b))
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      diffValues(a[key], b[key], `${path}.${key}`)
    );
  return [
    {
      class: 'unexplained',
      path,
      cpamp: a === undefined ? { absent: true } : a,
      prox: b === undefined ? { absent: true } : b,
    },
  ];
}
export interface D5Witness {
  // Independently replay the very same Prox query with the approved book and with only
  // D5 models removed. A difference is eligible only if BOTH replayed values match.
  priced?: AnalyticsResponse;
  unpriced?: AnalyticsResponse;
  // search-cpamp-only: the same query replayed with exactly the events that CPAMP's search
  // document matches only through fields or field-bridging wildcards that Prox does not have
  // (see searchCpampOnly.ts), searching as CPAMP's document does. `matched` uses the approved
  // book; `unpricedMatched` also drops the D5 models, for a path that both rules touch. Prox's
  // own value must equal the independent plain replay in `priced`, so a difference the replays
  // do not predict on the Prox side stays unexplained too.
  matched?: AnalyticsResponse;
  unpricedMatched?: AnalyticsResponse;
}
const COST_PATH = (path: string) => /\.cost(?:\.|$)/.test(path) || path.startsWith('$.rates[');
/** Paths where the witness response differs from `from`, keyed for exact value matching. */
function permittedDifferences(
  expected: AnalyticsResponse | undefined,
  actual: JsonObject,
  only: (path: string) => boolean = () => true
) {
  const permitted = new Map<string, Difference>();
  if (expected)
    for (const difference of diffValues(normalizeResponse(expected), actual))
      if (only(difference.path)) permitted.set(difference.path, difference);
  return permitted;
}
/**
 * Deep equality that ignores object key order and keeps each path's tolerance. A whole request
 * item is compared without `provider` and `trace_id`: those two differ by the documented
 * detail-provider and detail-trace rules whichever way the item reached the page.
 */
function sameValue(a: unknown, b: unknown, path: string): boolean {
  if (equalValue(a, b, path)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, i) => sameValue(value, b[i], `${path}[${i}]`));
  if (object(a) && object(b)) {
    const skipped = /^\$\.requests\.items\[\d+\]$/.test(path) ? ['provider', 'trace_id'] : [];
    const keys = Object.keys(a).filter((key) => !skipped.includes(key));
    const other = Object.keys(b).filter((key) => !skipped.includes(key));
    return (
      keys.length === other.length &&
      keys.every((key) => key in b && sameValue(a[key], b[key], `${path}.${key}`))
    );
  }
  return false;
}
export function compareResponses(
  cpamp: AnalyticsResponse,
  prox: AnalyticsResponse,
  witness?: D5Witness
): Difference[] {
  const a = normalizeResponse(cpamp),
    b = normalizeResponse(prox);
  // D5: CPAMP's expected value is the unpriced replay and Prox's the priced one.
  const d5 = witness?.priced && witness.unpriced
    ? permittedDifferences(witness.unpriced, normalizeResponse(witness.priced), COST_PATH)
    : new Map<string, Difference>();
  // Search: CPAMP's expected value is the CPAMP-document replay, Prox's the plain replay.
  const plain = witness?.priced ? normalizeResponse(witness.priced) : undefined;
  const search = plain ? permittedDifferences(witness?.matched, plain) : new Map<string, Difference>();
  const both = plain
    ? permittedDifferences(witness?.unpricedMatched, plain, COST_PATH)
    : new Map<string, Difference>();
  const coverage = coverageDifference(cpamp, prox);
  const differences = diffValues(a, b).filter(
    (d) => !/^\$\.coverage\.limitations(?:\[|\.|$)/.test(d.path)
  );
  if (coverage) differences.push(coverage);
  const explains = (permitted: Map<string, Difference>, difference: Difference) => {
    const allowed = permitted.get(difference.path);
    return (
      !!allowed &&
      sameValue(difference.cpamp, allowed.cpamp, difference.path) &&
      sameValue(difference.prox, allowed.prox, difference.path)
    );
  };
  return differences.map((difference) => {
    if (/^\$\.requests\.items\[\d+\]\.provider$/.test(difference.path))
      return { ...difference, class: 'detail-provider' };
    if (/^\$\.requests\.items\[\d+\]\.trace_id$/.test(difference.path))
      return { ...difference, class: 'detail-trace' };
    if (explains(d5, difference)) return { ...difference, class: 'd5-pricing' };
    if (explains(search, difference) || explains(both, difference))
      return { ...difference, class: 'search-cpamp-only' };
    return difference;
  });
}
export function needsD5Witness(differences: Difference[]) {
  return differences.some(
    (d) =>
      d.class === 'unexplained' && (/\.cost(?:\.|$)/.test(d.path) || d.path.startsWith('$.rates['))
  );
}
