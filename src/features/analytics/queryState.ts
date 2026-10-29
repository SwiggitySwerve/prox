import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';

export const ranges = ['1h', '24h', '7d', '30d'] as const;
export type AnalyticsRange = (typeof ranges)[number];
const rangeMilliseconds: Record<AnalyticsRange, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
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
export function rangeQuery(range: AnalyticsRange, now: number): AnalyticsQuery {
  return {
    from_ms: now - rangeMilliseconds[range],
    to_ms: now,
    time_zone: 'UTC',
    granularity: range === '7d' || range === '30d' ? 'day' : 'hour',
    outcome: 'all',
    limit: 25,
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
