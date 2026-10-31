import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';
import { rangeQuery } from '@/features/analytics/queryState';
import type { RecentRequestBucket } from '@/utils/recentRequests';
import type { TrafficWindow } from './types';

const HOUR_MS = 3_600_000;

/** Analytics' own 24 h hourly view, so a click-through lands on the same totals. */
export function dashboardAnalyticsQuery(nowMs: number, provider: string): AnalyticsQuery {
  return { ...rangeQuery('24h', nowMs, 'hour'), provider, limit: 1 };
}

export function analyticsWindow(nowMs: number) {
  const { from_ms, to_ms } = rangeQuery('24h', nowMs, 'hour');
  return { from_ms, to_ms };
}

/** An absent hour is only a quiet one when the retained ledger is complete, and every provider answered. */
export function analyticsUsable(
  providerIds: readonly string[],
  responses: ReadonlyMap<string, AnalyticsResponse>
): boolean {
  return (
    providerIds.length > 0 &&
    providerIds.every((id) => responses.get(id)?.coverage.raw_complete === true)
  );
}

export interface ProviderAnalytics {
  success: number;
  failure: number;
  total: number;
  successRate: number | null;
  buckets: RecentRequestBucket[];
}

const hourLabel = (startMs: number) => {
  const format = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${format.format(startMs)}-${format.format(startMs + HOUR_MS)}`;
};

/** Hour buckets start on the hour, so the first one holds only part of the window. */
const firstHour = (window: { from_ms: number }) => Math.floor(window.from_ms / HOUR_MS) * HOUR_MS;

const emptyHours = (window: { from_ms: number; to_ms: number }): RecentRequestBucket[] =>
  Array.from({ length: Math.ceil((window.to_ms - firstHour(window)) / HOUR_MS) }, (_, index) => ({
    time: hourLabel(firstHour(window) + index * HOUR_MS),
    success: 0,
    failed: 0,
  }));

/** Totals are analytics' own summaries; only the per-hour chart adds providers together. */
export function trafficFromAnalytics(
  window: { from_ms: number; to_ms: number },
  responses: ReadonlyMap<string, AnalyticsResponse>
): { traffic: TrafficWindow; providers: Map<string, ProviderAnalytics> } {
  const buckets = emptyHours(window);
  const providers = new Map<string, ProviderAnalytics>();
  let totalSuccess = 0;
  let totalFailure = 0;
  for (const [id, response] of responses) {
    const timeline = new Map(response.timeline.map((point) => [point.bucket_ms, point]));
    const own = emptyHours(window).map((bucket, index) => {
      const point = timeline.get(firstHour(window) + index * HOUR_MS);
      return { ...bucket, success: point?.success_calls ?? 0, failed: point?.failure_calls ?? 0 };
    });
    own.forEach((bucket, index) => {
      buckets[index].success += bucket.success;
      buckets[index].failed += bucket.failed;
    });
    const success = response.summary.success_calls;
    const failure = response.summary.failure_calls;
    const total = success + failure;
    providers.set(id, {
      success,
      failure,
      total,
      successRate: total > 0 ? (success / total) * 100 : null,
      buckets: own,
    });
    totalSuccess += success;
    totalFailure += failure;
  }
  const total = totalSuccess + totalFailure;
  const totals = buckets.map((bucket) => bucket.success + bucket.failed);
  const peakTotal = Math.max(0, ...totals);
  return {
    traffic: {
      buckets,
      totalSuccess,
      totalFailure,
      total,
      successRate: total > 0 ? (totalSuccess / total) * 100 : null,
      peakTotal,
      peakIndex: peakTotal > 0 ? totals.indexOf(peakTotal) : -1,
      windowMinutes: Math.round((window.to_ms - window.from_ms) / 60_000),
      bucketMinutes: 60,
    },
    providers,
  };
}
