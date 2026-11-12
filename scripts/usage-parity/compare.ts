// The frozen response normalization and the three explicit, counted exception rules.
import type { AnalyticsResponse } from '../../src/domain/analytics/types';

export const D5_MODELS = ['claude-fable-5-2', 'gpt-6.1-terra'] as const;
export type DifferenceClass =
  | 'unexplained'
  | 'd5-pricing'
  | 'detail-provider'
  | 'detail-trace'
  | 'drained-during-cpamp-outage'
  | 'ingest-gap';
export interface Difference {
  class: DifferenceClass;
  path: string;
  cpamp: unknown;
  prox: unknown;
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Relative tolerance only at cost.usd. In particular zero has no absolute epsilon. */
export function equalValue(a: unknown, b: unknown, path: string): boolean {
  if (a === b) return true;
  return (
    path.endsWith('.cost.usd') &&
    typeof a === 'number' &&
    typeof b === 'number' &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b))
  );
}
export function normalizeResponse(response: AnalyticsResponse): JsonObject {
  const value = structuredClone(response) as unknown as JsonObject;
  delete value.generated_at_ms;
  const coverage = value.coverage as JsonObject;
  delete coverage.price_revision;
  const requests = value.requests as JsonObject;
  delete requests.next_before_id;
  const items = requests.items as JsonObject[];
  items.forEach((item) => delete item.id);
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
  priced: AnalyticsResponse;
  unpriced: AnalyticsResponse;
}
export function compareResponses(
  cpamp: AnalyticsResponse,
  prox: AnalyticsResponse,
  witness?: D5Witness
): Difference[] {
  const a = normalizeResponse(cpamp),
    b = normalizeResponse(prox);
  const permitted = new Map<string, Difference>();
  if (witness) {
    for (const difference of diffValues(
      normalizeResponse(witness.unpriced),
      normalizeResponse(witness.priced)
    )) {
      if (/\.cost(?:\.|$)/.test(difference.path) || difference.path.startsWith('$.rates['))
        permitted.set(difference.path, difference);
    }
  }
  return diffValues(a, b).map((difference) => {
    if (/^\$\.requests\.items\[\d+\]\.provider$/.test(difference.path))
      return { ...difference, class: 'detail-provider' };
    if (/^\$\.requests\.items\[\d+\]\.trace_id$/.test(difference.path))
      return { ...difference, class: 'detail-trace' };
    const allowed = permitted.get(difference.path);
    if (
      allowed &&
      (equalValue(difference.cpamp, allowed.cpamp, difference.path) ||
        JSON.stringify(difference.cpamp) === JSON.stringify(allowed.cpamp)) &&
      (equalValue(difference.prox, allowed.prox, difference.path) ||
        JSON.stringify(difference.prox) === JSON.stringify(allowed.prox))
    )
      return { ...difference, class: 'd5-pricing' };
    return difference;
  });
}
export function needsD5Witness(differences: Difference[]) {
  return differences.some(
    (d) =>
      d.class === 'unexplained' && (/\.cost(?:\.|$)/.test(d.path) || d.path.startsWith('$.rates['))
  );
}
