import { afterEach, expect, test } from 'bun:test';
import { queryAnalytics } from '../server/usage/analytics';
import { pricingRowCompare, type PricingOrderKey } from '../server/usage/analyticsPricing';
import { parseRateBook } from '../server/usage/rates';
import { USAGE_FLAG } from '../server/usage/types';
import { analyticsStore, BASE, event, query, rates, rateState } from './helpers/usageAnalytics';

let fixture: ReturnType<typeof analyticsStore>;
afterEach(() => fixture?.close());
const complete = Object.values(USAGE_FLAG).reduce((left, right) => left | right, 0);
const zero = {
  inputTotal: 0,
  inputUncached: 0,
  outputTotal: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
};
const aggregateReasons = ['usage-presence-unknown', 'legacy-record-kind-unknown'];

for (const flags of [complete, 0]) {
  test(`CPAMP positive aggregate uses unknown presence without event component metadata (flags ${flags})`, () => {
    const f = (fixture = analyticsStore());
    f.insert([event(1, { usageFlags: flags, recordKind: 0 })]);
    const response = queryAnalytics(f.db, query(), rateState());
    const expected = { usd: 0.0015, status: 'partial', reasons: aggregateReasons, priced_calls: 1 };
    expect(response.summary.cost).toEqual(expected);
    expect(response.timeline[0].cost).toEqual(expected);
    expect(response.models[0].cost).toEqual(expected);
    expect(response.providers[0].cost).toEqual(expected);
  });
}
test('CPAMP fully reported zero aggregate is unpriced, while its request is measured zero', () => {
  const f = (fixture = analyticsStore());
  f.insert([event(1, { usageFlags: complete, tokens: zero })]);
  const response = queryAnalytics(f.db, query(), rateState());
  const expected = { usd: null, status: 'unpriced', reasons: aggregateReasons, unpriced_calls: 1 };
  expect(response.summary.cost).toEqual(expected);
  expect(response.timeline[0].cost).toEqual(expected);
  expect(response.models[0].cost).toEqual(expected);
  expect(response.providers[0].cost).toEqual(expected);
  expect(response.requests.items[0].cost).toEqual({ usd: 0, status: 'estimated', reasons: [] });
});
for (const recordKind of [0, 1] as const) {
  test(`CPAMP request cost has no aggregate counts or legacy reason (record kind ${recordKind})`, () => {
    const f = (fixture = analyticsStore());
    f.insert([event(1, { usageFlags: complete, recordKind })]);
    expect(queryAnalytics(f.db, query(), rateState()).requests.items[0].cost).toEqual({
      usd: 0.0015,
      status: 'estimated',
      reasons: [],
    });
  });
}
test('summary/provider call order is folded across buckets; timeline follows lexical pricing order', () => {
  const f = (fixture = analyticsStore());
  const rateBook = parseRateBook({
    version: 1,
    models: { 'z-empty': { input: null, output: null, cache_read: null, cache_write: null } },
  });
  f.insert([
    event(1, { model: 'a-missing', billingModel: 'a-missing', requestedModel: 'a-missing' }),
    event(2, { model: 'z-empty', billingModel: 'z-empty', requestedModel: 'z-empty' }),
    event(3, {
      model: 'z-empty',
      billingModel: 'z-empty',
      requestedModel: 'z-empty',
      tsMs: BASE + 3600001,
    }),
  ]);
  const response = queryAnalytics(f.db, query(), rateState(rateBook));
  expect(response.summary.cost.reasons).toEqual([
    'model-rates-not-configured',
    'legacy-record-kind-unknown',
    'model-rate-unavailable',
  ]);
  expect(response.providers[0].cost.reasons).toEqual(response.summary.cost.reasons);
  expect(response.timeline[0].cost.reasons).toEqual([
    'model-rate-unavailable',
    'legacy-record-kind-unknown',
    'model-rates-not-configured',
  ]);
  expect(response.timeline[1].cost.reasons).toEqual([
    'model-rates-not-configured',
    'legacy-record-kind-unknown',
  ]);
  expect(response.models.map((row) => row.cost.reasons)).toEqual([
    ['model-rate-unavailable', 'legacy-record-kind-unknown'],
    ['model-rates-not-configured', 'legacy-record-kind-unknown'],
  ]);
});
test('models inherit global stat ordering; a shared model makes provider ordering use its own calls', () => {
  const f = (fixture = analyticsStore());
  const rateBook = parseRateBook({
    version: 1,
    models: { 'z-empty': { input: null, output: null, cache_read: null, cache_write: null } },
  });
  f.insert(
    Array.from({ length: 8 }, (_, i) =>
      event(i, {
        model: 'shared',
        requestedModel: 'shared',
        billingModel: i < 3 ? 'a-missing' : 'z-empty',
        provider: i < 4 ? 'claude' : 'codex',
      })
    )
  );
  const response = queryAnalytics(f.db, query(), rateState(rateBook));
  const global = [
    'model-rates-not-configured',
    'legacy-record-kind-unknown',
    'model-rate-unavailable',
  ];
  const local = [
    'model-rate-unavailable',
    'legacy-record-kind-unknown',
    'model-rates-not-configured',
  ];
  expect(response.summary.cost.reasons).toEqual(global);
  expect(response.models[0].cost.reasons).toEqual(global);
  expect(response.providers.find((row) => row.key === 'claude')!.cost.reasons).toEqual(local);
  expect(response.providers.find((row) => row.key === 'codex')!.cost.reasons).toEqual([
    'model-rates-not-configured',
    'legacy-record-kind-unknown',
  ]);
  expect(response.timeline[0].cost.reasons).toEqual(local);
});
test('CPAMP stable pricing order determines the exact floating-point subtotal', () => {
  const f = (fixture = analyticsStore());
  const rateBook = parseRateBook({
    version: 1,
    models: Object.fromEntries([
      ['z-huge', { ...rates, input: 1e16 }],
      ['a-one', { ...rates, input: 1 }],
      ['b-one', { ...rates, input: 1 }],
    ]),
  });
  f.insert(
    ['z-huge', 'b-one', 'a-one'].map((model, i) =>
      event(i, {
        model,
        billingModel: model,
        requestedModel: model,
        tokens: { ...zero, inputTotal: 1000000, inputUncached: 1000000, total: 1000000 },
      })
    )
  );
  const response = queryAnalytics(f.db, query(), rateState(rateBook));
  expect(response.summary.cost.usd).toBe(10000000000000002);
  expect(response.timeline[0].cost.usd).toBe(10000000000000002);
  expect(response.providers[0].cost.usd).toBe(10000000000000002);
});
test('pricingRowLess field precedence and UTF-8 string order match Go exactly', () => {
  const base: PricingOrderKey = {
    model: 'm',
    billingModel: 'b',
    pricingModel: 'p',
    tier: 'standard',
    band: null,
  };
  for (const [left, right] of [
    [
      { ...base, model: 'a', billingModel: 'z' },
      { ...base, model: 'b', billingModel: 'a' },
    ],
    [
      { ...base, billingModel: 'a', pricingModel: 'z' },
      { ...base, billingModel: 'b', pricingModel: 'a' },
    ],
    [
      { ...base, pricingModel: 'a', tier: 'z' },
      { ...base, pricingModel: 'b', tier: 'a' },
    ],
    [
      { ...base, tier: 'a', band: 2000 },
      { ...base, tier: 'b', band: null },
    ],
    [base, { ...base, band: 1000 }],
    [
      { ...base, model: '\uE000' },
      { ...base, model: '\u{10000}' },
    ],
  ]) {
    expect(pricingRowCompare(left, right)).toBeLessThan(0);
    expect(pricingRowCompare(right, left)).toBeGreaterThan(0);
  }
  expect(pricingRowCompare(base, { ...base })).toBe(0);
});
test('per-view pricing folds metadata/outcome groups without changing the SQL grouping keys', () => {
  const f = (fixture = analyticsStore());
  f.insert([
    event(1, { usageFlags: complete, tier: 'standard' }),
    event(2, {
      usageFlags: 0,
      recordKind: 0,
      tier: 'standard',
      tokens: zero,
      failed: true,
      tsMs: BASE + 3600001,
    }),
  ]);
  const response = queryAnalytics(f.db, query(), rateState());
  expect(response.summary.cost).toEqual({
    usd: 0.0015,
    status: 'partial',
    reasons: aggregateReasons,
    priced_calls: 2,
  });
  expect(response.timeline[0].cost).toEqual({
    usd: 0.0015,
    status: 'partial',
    reasons: aggregateReasons,
    priced_calls: 1,
  });
  expect(response.timeline[1].cost).toEqual({
    usd: null,
    status: 'unpriced',
    reasons: aggregateReasons,
    unpriced_calls: 1,
  });
  expect(response.requests.items[0].cost).toEqual({
    usd: null,
    status: 'unavailable',
    reasons: ['usage-presence-unknown'],
  });
});
