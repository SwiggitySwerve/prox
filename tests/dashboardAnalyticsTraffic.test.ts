import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AnalyticsResponse } from '../src/domain/analytics/types';
import { rangeQuery } from '../src/features/analytics/queryState';
import {
  analyticsUsable,
  analyticsWindow,
  dashboardAnalyticsQuery,
  trafficFromAnalytics,
} from '../src/features/dashboard/analyticsTraffic';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 9, 30, 6, 35);
const window = analyticsWindow(now);

const response = (
  summary: [number, number],
  timeline: Array<[number, number, number]>,
  rawComplete = true
) =>
  ({
    coverage: { raw_complete: rawComplete },
    summary: {
      calls: summary[0] + summary[1],
      success_calls: summary[0],
      failure_calls: summary[1],
    },
    timeline: timeline.map(([bucket_ms, success_calls, failure_calls]) => ({
      bucket_ms,
      success_calls,
      failure_calls,
      calls: success_calls + failure_calls,
    })),
  }) as unknown as AnalyticsResponse;

describe('dashboard analytics window', () => {
  test('is the Analytics page 24 h view, so a click-through shows the same totals', () => {
    expect(window).toEqual({ from_ms: now - 24 * HOUR, to_ms: now });
    expect(dashboardAnalyticsQuery(now, 'claude')).toEqual({
      ...rangeQuery('24h', now, 'hour'),
      provider: 'claude',
      limit: 1,
    });
  });
});

describe('traffic from analytics', () => {
  // The first hour is partial: its bucket starts before the window does.
  const first = Date.UTC(2026, 9, 29, 6);
  const claude = response(
    [90, 10],
    [
      [first + 2 * HOUR, 40, 10],
      [first + 24 * HOUR, 50, 0],
    ]
  );
  const codex = response([30, 0], [[first + 2 * HOUR, 30, 0]]);
  const { traffic, providers } = trafficFromAnalytics(
    window,
    new Map([
      ['claude', claude],
      ['codex', codex],
    ])
  );

  test('totals come from each provider summary, not from page counters', () => {
    expect([traffic.totalSuccess, traffic.totalFailure, traffic.total]).toEqual([120, 10, 130]);
    expect(traffic.successRate).toBeCloseTo((120 / 130) * 100);
    expect(providers.get('claude')).toMatchObject({ success: 90, failure: 10, total: 100 });
    expect(providers.get('codex')).toMatchObject({ success: 30, failure: 0, total: 30 });
    expect(providers.get('codex')!.successRate).toBe(100);
  });

  test('hours without events are quiet zeros and providers add per hour', () => {
    expect(traffic.buckets).toHaveLength(25);
    expect(traffic.windowMinutes).toBe(24 * 60);
    expect(traffic.bucketMinutes).toBe(60);
    expect(traffic.buckets[0]).toMatchObject({ success: 0, failed: 0 });
    expect(traffic.buckets[2]).toMatchObject({ success: 70, failed: 10 });
    expect(traffic.buckets[24]).toMatchObject({ success: 50, failed: 0 });
    expect(traffic.peakIndex).toBe(2);
    expect(traffic.peakTotal).toBe(80);
    expect(traffic.buckets[2].time).toMatch(/^\d\d:\d\d-\d\d:\d\d$/);
  });

  test('a window that starts on the hour has exactly 24 buckets', () => {
    const aligned = analyticsWindow(Date.UTC(2026, 9, 30, 6));
    const whole = trafficFromAnalytics(aligned, new Map([['xai', response([0, 0], [])]]));
    expect(whole.traffic.buckets).toHaveLength(24);
  });

  test('a provider with no events has no success rate rather than 0%', () => {
    const empty = trafficFromAnalytics(window, new Map([['xai', response([0, 0], [])]]));
    expect(empty.providers.get('xai')).toMatchObject({ total: 0, successRate: null });
    expect(empty.traffic.successRate).toBeNull();
  });
});

describe('when analytics may be used', () => {
  test('only with a complete retained ledger for every provider asked', () => {
    const ok = response([1, 0], []);
    const partial = response([1, 0], [], false);
    expect(
      analyticsUsable(
        ['claude', 'codex'],
        new Map([
          ['claude', ok],
          ['codex', ok],
        ])
      )
    ).toBe(true);
    expect(
      analyticsUsable(
        ['claude', 'codex'],
        new Map([
          ['claude', ok],
          ['codex', partial],
        ])
      )
    ).toBe(false);
    expect(analyticsUsable(['claude', 'codex'], new Map([['claude', ok]]))).toBe(false);
    expect(analyticsUsable([], new Map())).toBe(false);
  });
});

describe('analytics numbers stay current', () => {
  test('polls on the same cadence as the counters, not only when the provider set changes', () => {
    const source = readFileSync('src/features/dashboard/hooks/useDashboardOverview.ts', 'utf8');
    expect(source).toContain('PROVIDER_RECENT_REQUESTS_STALE_TIME_MS');
    expect(source).toMatch(/useInterval\(\s*\(\) => \{\s*void loadAnalytics\(\)/);
  });
});
