import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';

export const ranges = ['1h', '24h', 'today', 'yesterday', '7d', '30d'] as const;
export type AnalyticsRange = (typeof ranges)[number];
/** Auto lets the range pick: hours up to a day, days beyond. The server buckets only hour or day. */
export const buckets = ['auto', 'hour', 'day'] as const;
export type AnalyticsBucket = (typeof buckets)[number];
const DAY = 86_400_000;
const rangeMilliseconds: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 3_600_000,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};
export const analyticsTabs = [
  'overview',
  'tokens',
  'cost',
  'performance',
  'requests',
  'rates',
] as const;
export type AnalyticsTab = (typeof analyticsTabs)[number];
export function analyticsTab(value: string | null): AnalyticsTab {
  return analyticsTabs.find((tab) => tab === value) ?? 'overview';
}
export function rangeQuery(
  range: AnalyticsRange,
  now: number,
  bucket: AnalyticsBucket = 'auto'
): AnalyticsQuery {
  // Today and Yesterday are UTC calendar days, matching the page's UTC scope.
  const midnight = Math.floor(now / DAY) * DAY;
  const [from, to] =
    range === 'today'
      ? [midnight, now]
      : range === 'yesterday'
        ? [midnight - DAY, midnight]
        : [now - rangeMilliseconds[range], now];
  return {
    from_ms: from,
    to_ms: to,
    time_zone: 'UTC',
    granularity: bucket !== 'auto' ? bucket : range === '7d' || range === '30d' ? 'day' : 'hour',
    outcome: 'all',
    limit: 25,
  };
}
/** A provider named in the address: short, non-empty text only. */
export function addressProvider(value: string | null): string | undefined {
  const text = value?.trim();
  return text && text.length <= 200 ? text : undefined;
}
type Filters = Pick<AnalyticsQuery, 'provider' | 'model' | 'outcome' | 'search'>;
/** A provider in the address starts a fresh view: remembered model, search and outcome would silently narrow its totals. */
export function startingFilters(provider: string | undefined, saved: Partial<Filters>): Filters {
  return provider
    ? { provider, model: undefined, outcome: 'all', search: undefined }
    : {
        provider: saved.provider,
        model: saved.model,
        outcome: saved.outcome ?? 'all',
        search: saved.search,
      };
}
export function withoutCursor(query: AnalyticsQuery): AnalyticsQuery {
  const filters = { ...query };
  delete filters.before_id;
  delete filters.before_ms;
  return filters;
}
/** A bucket click uses the same half-open UTC interval as the server's rollup. */
export function bucketQuery(query: AnalyticsQuery, bucket: number): AnalyticsQuery {
  const width = query.granularity === 'day' ? 86_400_000 : 3_600_000;
  return {
    ...withoutCursor(query),
    from_ms: Math.max(query.from_ms, bucket),
    to_ms: Math.min(query.to_ms, bucket + width),
  };
}
export function nextPageQuery(
  query: AnalyticsQuery,
  page: AnalyticsResponse['requests']
): AnalyticsQuery | null {
  if (!page.has_more || page.next_before_ms === null || page.next_before_id === null) return null;
  return { ...query, before_ms: page.next_before_ms, before_id: page.next_before_id };
}
