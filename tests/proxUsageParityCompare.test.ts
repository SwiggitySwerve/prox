import { describe, expect, test } from 'bun:test';
import {
  compareResponses,
  diffValues,
  equalValue,
  normalizeResponse,
} from '../scripts/usage-parity/compare';
import { matrix, selectCases, previousUtcDay, DAY } from '../scripts/usage-parity/matrix';
import { validateAnalyticsQuery } from '../server/usage/validate';
import { queryAnalytics } from '../server/usage/analytics';
import { analyticsStore, event, query, rateState, rates } from './helpers/usageAnalytics';
import { parseRateBook } from '../server/usage/rates';

function response() {
  const f = analyticsStore();
  try {
    f.insert([event(1), event(2)]);
    return queryAnalytics(f.db, query(), rateState());
  } finally {
    f.close();
  }
}
describe('frozen response comparison', () => {
  test('ignores exactly four volatile fields and equal-timestamp item order', () => {
    const a = response(),
      b = structuredClone(a);
    b.generated_at_ms++;
    b.coverage.price_revision = 'other';
    b.requests.next_before_id = 999;
    b.requests.items.forEach((row) => {
      row.id = `different-${row.id}`;
    });
    b.requests.items.reverse();
    expect(compareResponses(a, b)).toEqual([]);
    expect(normalizeResponse(a)).not.toHaveProperty('generated_at_ms');
    expect(a.requests.items[0].id).toBeDefined();
  });
  test('all counters, averages, p95s, coverage and non-tied order remain exact', () => {
    const a = response();
    const changes = [
      (b: typeof a) => {
        b.summary.calls++;
      },
      (b: typeof a) => {
        b.summary.average_latency_ms! += 1e-10;
      },
      (b: typeof a) => {
        b.summary.p95_latency_ms! += 1e-10;
      },
      (b: typeof a) => {
        b.summary.p95_ttft_ms! += 1e-10;
      },
      (b: typeof a) => {
        b.coverage.raw_complete = !b.coverage.raw_complete;
      },
      (b: typeof a) => {
        b.requests.next_before_ms = 123;
      },
      (b: typeof a) => {
        b.coverage.limitations.reverse();
      },
      (b: typeof a) => {
        b.requests.items[0].timestamp_ms++;
        b.requests.items.reverse();
      },
    ];
    for (const change of changes) {
      const b = structuredClone(a);
      change(b);
      expect(compareResponses(a, b).some((d) => d.class === 'unexplained')).toBe(true);
    }
  });
  test('relative tolerance applies only to cost.usd, including null and zero boundaries', () => {
    expect(equalValue(100, 100 + 5e-8, '$.summary.cost.usd')).toBe(true);
    expect(equalValue(100, 100 + 2e-7, '$.summary.cost.usd')).toBe(false);
    expect(equalValue(0, 1e-20, '$.summary.cost.usd')).toBe(false);
    expect(equalValue(null, 0, '$.summary.cost.usd')).toBe(false);
    expect(equalValue(1, 1 + 1e-10, '$.summary.average_latency_ms')).toBe(false);
    expect(diffValues({ a: 1 }, { a: 2 })[0]).toMatchObject({ cpamp: 1, prox: 2 });
  });
  test('provider and trace detail exceptions are separate counted differences only', () => {
    const a = response(),
      b = structuredClone(a);
    a.requests.items[0].provider = 'snapshot-provider';
    b.requests.items[0].provider = 'payload-provider';
    a.requests.items[0].trace_id = 'header-trace';
    b.requests.items[0].trace_id = 'payload-trace';
    const d = compareResponses(a, b);
    expect(d.map((v) => v.class).sort()).toEqual(['detail-provider', 'detail-trace']);
    b.providers[0].key = 'wrong-provider';
    expect(compareResponses(a, b).some((v) => v.class === 'unexplained')).toBe(true);
  });
  test('D5 differences need both approved-book and unpriced replay witnesses', () => {
    const f = analyticsStore();
    try {
      f.insert([
        event(1, {
          model: 'claude-fable-5-2',
          billingModel: 'claude-fable-5-2',
          requestedModel: 'claude-fable-5-2',
        }),
        event(2, {
          model: 'gpt-6.1-terra',
          billingModel: 'gpt-6.1-terra',
          requestedModel: 'gpt-6.1-terra',
        }),
        event(3),
      ]);
      const priced = queryAnalytics(
        f.db,
        query(),
        rateState(
          parseRateBook({
            version: 1,
            models: { 'claude-fable-5-2': rates, 'gpt-6.1-terra': rates, 'claude-test-4': rates },
          })
        )
      );
      const unpriced = queryAnalytics(f.db, query(), rateState());
      expect(compareResponses(unpriced, priced).some((v) => v.class === 'unexplained')).toBe(true);
      const differences = compareResponses(unpriced, priced, { priced, unpriced });
      expect(differences.length).toBeGreaterThan(20);
      expect(new Set(differences.map((v) => v.class))).toEqual(new Set(['d5-pricing']));
      const corrupt = structuredClone(priced);
      corrupt.summary.cost.usd! += 0.01;
      corrupt.timeline[0].p95_latency_ms!++;
      corrupt.summary.input_tokens++;
      const d = compareResponses(unpriced, corrupt, { priced, unpriced });
      for (const path of [
        '$.summary.cost.usd',
        '$.summary.input_tokens',
        '$.timeline[0].p95_latency_ms',
      ])
        expect(d.find((v) => v.path === path)?.class).toBe('unexplained');
      const wrongUnpriced = structuredClone(unpriced);
      wrongUnpriced.summary.cost.usd! += 0.1;
      expect(
        compareResponses(wrongUnpriced, priced, { priced, unpriced }).find(
          (v) => v.path === '$.summary.cost.usd'
        )?.class
      ).toBe('unexplained');
    } finally {
      f.close();
    }
  });
});
describe('ported matrices', () => {
  test('preserves source case counts, UTC granularity rotation and range lengths', () => {
    const end = Date.UTC(2026, 10, 13, 20, 17, 23, 456);
    const quick = matrix('quick', end),
      full = matrix('full', end);
    expect(quick).toHaveLength(672);
    expect(full).toHaveLength(5904);
    expect(quick.filter((c) => c.family === 'rollup')).toHaveLength(240);
    expect(full.filter((c) => c.family === 'rollup')).toHaveLength(720);
    expect(new Set(full.map((c) => (c.query.to_ms - c.query.from_ms) / 3600000))).toEqual(
      new Set([1, 6, 24, 168, 720, 744])
    );
    for (const c of full) expect(validateAnalyticsQuery(c.query).time_zone).toBe('UTC');
    expect(new Set(quick.map((c) => c.id)).size).toBe(672);
    expect(selectCases(quick, 10)).toHaveLength(10);
    expect(selectCases(quick, 10)).toEqual(selectCases(quick, 10));
  });
  test('previous UTC day ignores the host local zone and current partial day', () => {
    const now = Date.UTC(2026, 10, 13, 4, 30);
    expect(previousUtcDay(now)).toEqual({
      from_ms: Date.UTC(2026, 10, 12),
      to_ms: Date.UTC(2026, 10, 13),
    });
    expect(previousUtcDay(now).to_ms - previousUtcDay(now).from_ms).toBe(DAY);
  });
});
