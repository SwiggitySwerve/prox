import { afterEach, expect, test } from 'bun:test';
import { queryAnalytics } from '../server/usage/analytics';
import { parseAnalyticsQuery, validateAnalyticsQuery } from '../server/usage/validate';
import { parseRateBook } from '../server/usage/rates';
import { estimateCost } from '../server/usage/pricing';
import { USAGE_FLAG } from '../server/usage/types';
import {
  analyticsStore,
  BASE,
  book,
  event,
  query,
  rates,
  rateState,
} from './helpers/usageAnalytics';

let fixture: ReturnType<typeof analyticsStore>;
afterEach(() => fixture?.close());
const setup = () => (fixture = analyticsStore());

test('CPAMP bounds, strict JSON and UTC narrowing', () => {
  const valid = query();
  for (const patch of [
    { from_ms: 0 },
    { to_ms: BASE },
    { to_ms: BASE + 32 * 86400000 },
    { from_ms: 253402300799998, to_ms: 253402300800000 },
    { granularity: 'minute' },
    { outcome: 'unknown' },
    { time_zone: 'America/New_York' },
    { limit: 201 },
    { limit: -1 },
    { limit: 1.5 },
    { before_ms: BASE },
    { before_id: 1 },
    { before_ms: BASE + 86400000, before_id: 1 },
    { before_ms: BASE, before_id: 0 },
    { before_ms: BASE, before_id: 2 ** 53 },
    { search: 'é'.repeat(129) },
    { search: 'a\u0085b' },
    { provider: 'a'.repeat(129) },
    { model: 'a'.repeat(257) },
    { catalog: Array(1001).fill({}) },
    { unknown: true },
    { catalog: [{ id: 'x', provider: 'p', instance_id: 'i', secret: 'x' }] },
    { catalog: [{ id: '', provider: 'p', instance_id: 'i' }] },
  ])
    expect(() => validateAnalyticsQuery({ ...valid, ...patch })).toThrow();
  for (const suffix of [' {}', ' true', ' trailing'])
    expect(() => parseAnalyticsQuery(JSON.stringify(valid) + suffix)).toThrow();
  expect(query({ limit: 0 }).limit).toBe(100);
  expect(query({ limit: 200, search: 'é'.repeat(128), to_ms: BASE + 31 * 86400000 }).limit).toBe(
    200
  );
});
test('one read snapshot covers aggregates, latency, request page, selectors and coverage', () => {
  const f = setup();
  f.insert([event(1)]);
  const response = queryAnalytics(f.db, query(), rateState(), {
    afterAggregate: () => {
      f.insert([event(2, { latencyMs: 99999, model: 'new-model', provider: 'new-provider' })], 2);
      f.store.recordGap({ instance: 'new', fromMs: BASE, toMs: BASE + 100, reason: 'test' });
    },
  });
  expect(response.summary.calls).toBe(1);
  expect(response.requests.total_count).toBe(1);
  expect(response.requests.items).toHaveLength(1);
  expect(response.summary.p95_latency_ms).toBe(1500);
  expect(response.filter_options.models).toEqual(['client-claude']);
  expect(response.coverage.raw_complete).toBe(true);
  expect(response.coverage.limitations.some((text) => text.includes('imported'))).toBe(false);
  expect(queryAnalytics(f.db, query(), rateState()).summary.calls).toBe(2);
});
test('CPAMP whole scope, same-timestamp paging, supplementary exclusion and safe fields', () => {
  const f = setup();
  f.insert([
    event(1),
    event(2, { failed: true, statusCode: 429 }),
    event(3, { recordKind: 2 }),
    event(4, {
      billingModel: 'missing',
      model: 'missing',
      requestedModel: 'missing',
      provider: 'codex',
      instance: null,
    }),
  ]);
  let q = query({
    limit: 1,
    catalog: [{ instance_id: 'i', instance_label: 'I', provider: 'claude', id: 'unused' }],
  });
  let response = queryAnalytics(f.db, q, rateState());
  expect(response.summary.calls).toBe(3);
  expect(response.summary.failure_calls).toBe(1);
  expect(response.summary.cost).toMatchObject({
    status: 'partial',
    priced_calls: 2,
    unpriced_calls: 1,
    reasons: expect.arrayContaining(['legacy-record-kind-unknown', 'model-rate-unavailable']),
  });
  expect(response.timeline[0].calls).toBe(3);
  expect(response.models).toHaveLength(2);
  expect(response.rates[0]).toMatchObject({ id: 'unused', registered: true });
  expect(response.coverage.source_attribution).toBe('unavailable');
  const seen: string[] = [];
  while (true) {
    seen.push(...response.requests.items.map((r) => r.execution_id!));
    if (!response.requests.has_more) break;
    q = query({
      limit: 1,
      before_ms: response.requests.next_before_ms,
      before_id: response.requests.next_before_id,
    });
    response = queryAnalytics(f.db, q, rateState());
    expect(response.summary.calls).toBe(3);
  }
  expect(new Set(seen).size).toBe(3);
  expect(response.coverage.source_attribution).toBe('partial');
  expect(response.requests.items[0].cost.status).toBe('estimated');
  const failed = queryAnalytics(f.db, query({ outcome: 'failed' }), rateState());
  expect(failed.requests.items[0].error_summary).toBe('Upstream HTTP 429');
  expect(failed.filter_options.models).toEqual(['client-claude', 'missing']);
  const json = JSON.stringify(failed);
  for (const secret of ['api_key_hash', 'input_uncached', 'raw_json', 'AUTH_SENTINEL'])
    expect(json).not.toContain(secret);
});
test('per-event context bands, candidate precedence and service tiers equal independent event pricing', () => {
  const f = setup();
  const rateBook = parseRateBook({
    version: 1,
    models: {
      'claude-test-4': {
        ...rates,
        context_tiers: [
          { ...rates, input: 4, above_input_tokens: 1000 },
          { ...rates, input: 10, above_input_tokens: 2000 },
        ],
        service_tiers: [{ ...rates, input: 8, names: ['priority', 'fast'] }],
      },
      'base-only': rates,
      'alias(high)': { ...rates, input: 7 },
    },
  });
  const events = [1000, 1001, 2000, 2001, 500, 500].map((input, i) =>
    event(i, {
      tier: i % 2 ? 'priority' : 'standard',
      tokens: {
        inputTotal: input,
        inputUncached: input - 100,
        cacheRead: 80,
        cacheWrite: 20,
        outputTotal: 100,
        reasoning: 5,
        total: input + 100,
      },
    })
  );
  events.push(event(10, { billingModel: 'base-only', tokens: events[3].tokens }));
  events.push(
    event(11, { billingModel: 'missing', model: 'alias', requestedModel: 'alias(high)' })
  );
  f.insert(events);
  const response = queryAnalytics(f.db, query(), rateState(rateBook));
  const expected = events.reduce(
    (sum, row) =>
      sum +
      (estimateCost(
        {
          model: row.model,
          billingModel: row.billingModel,
          requestedModel: row.requestedModel,
          tier: row.tier,
          tokens: row.tokens,
          usageFlags: row.usageFlags,
          recordKind: row.recordKind,
        },
        rateBook
      ).usd ?? 0),
    0
  );
  expect(response.summary.cost.usd!).toBeCloseTo(expected, 12);
  expect(response.requests.items.reduce((sum, row) => sum + row.cost.usd!, 0)).toBeCloseTo(
    expected,
    12
  );
  expect(response.coverage.price_revision).toBe(rateState(rateBook).price_revision!);
  // Several base-band events sum above a threshold; none may be repriced as long context.
  expect(response.summary.cost.reasons).toEqual(['legacy-record-kind-unknown']);
});
test('presence nulls, speed, diagnostics and unknown provider/trace provenance', () => {
  const f = setup();
  f.insert([
    event(1, {
      usageFlags: 0,
      tokens: {
        inputTotal: 123,
        inputUncached: 123,
        outputTotal: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 123,
      },
      provider: 'payload-provider',
      traceId: 'payload-trace',
      userAgent: 'client api_key=AUTH_SENTINEL',
      path: '/v1/messages?key=PATH_SENTINEL',
      failed: true,
      statusCode: 0,
    }),
    event(2, {
      usageFlags:
        USAGE_FLAG.presenceReported |
        USAGE_FLAG.fieldsPresent |
        USAGE_FLAG.inputTokens |
        USAGE_FLAG.outputTokens,
      tokens: {
        inputTotal: 0,
        inputUncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        outputTotal: 0,
        reasoning: 0,
        total: 0,
      },
    }),
  ]);
  const items = queryAnalytics(f.db, query(), rateState()).requests.items;
  expect(items[0]).toMatchObject({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: null,
    uncached_input_tokens: null,
    output_tokens_per_second: 0,
  });
  expect(items[1]).toMatchObject({
    input_tokens: 123,
    output_tokens: null,
    cache_read_tokens: null,
    usage_presence: 'unknown',
    usage_fields: null,
    trace_id: 'payload-trace',
    provider: 'payload-provider',
    error_summary: 'Execution failed',
    user_agent: 'client api_key=[redacted]',
    path: '/v1/messages',
    output_tokens_per_second: null,
  });
  expect(JSON.stringify(items)).not.toContain('SENTINEL');
});
test('coverage reports only overlapping gaps, pruning, imports, rate failure and unknown normalization', () => {
  const f = setup();
  f.insert([event(1, { provider: 'other' })], 2);
  f.store.setMeta('retention_floor_ms', String(BASE + 10));
  f.store.recordGap({ instance: 'primary', fromMs: BASE + 10, toMs: BASE + 20, reason: 'test' });
  f.store.recordGap({ instance: 'outside', fromMs: BASE - 100, toMs: BASE, reason: 'test' });
  const response = queryAnalytics(f.db, query(), rateState(book, 'invalid file'));
  expect(response.coverage.raw_complete).toBe(false);
  expect(response.coverage.limitations.join('\n')).toContain('primary');
  expect(response.coverage.limitations.join('\n')).not.toContain('outside');
  for (const reason of ['pruned', 'imported', 'rate book failed', 'unknown provider', 'in flight'])
    expect(response.coverage.limitations.join('\n')).toContain(reason);
  expect(response.coverage.limitations.join('\n')).not.toContain('successive reads');
  expect(
    queryAnalytics(f.db, query({ from_ms: BASE + 20 }), rateState()).coverage.raw_complete
  ).toBe(true);
});
test('empty scope remains unavailable with null timing and no cursor', () => {
  const f = setup();
  const result = queryAnalytics(f.db, query(), rateState());
  expect(result.summary.cost).toEqual({
    usd: null,
    status: 'unavailable',
    reasons: ['no-retained-events'],
  });
  expect(result.summary.average_latency_ms).toBeNull();
  expect(result.summary.p95_latency_ms).toBeNull();
  expect(result.timeline).toEqual([]);
  expect(result.requests).toEqual({
    items: [],
    total_count: 0,
    has_more: false,
    next_before_ms: null,
    next_before_id: null,
  });
});
test('CPAMP status and reason cases survive SQL grouping and request projection', () => {
  const f = setup();
  const rateBook = parseRateBook({
    version: 1,
    models: {
      paid: rates,
      free: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      empty: { input: null, output: null, cache_read: null, cache_write: null },
      incomplete: { input: null, output: null, cache_read: 0.5, cache_write: null },
      'no-cache-read': { ...rates, cache_read: null },
    },
  });
  const complete = Object.values(USAGE_FLAG).reduce((a, b) => a | b, 0);
  const zero = {
    inputTotal: 0,
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    outputTotal: 0,
    reasoning: 0,
    total: 0,
  };
  const cases = [
    { model: 'paid', status: 'estimated', reasons: [] },
    { model: 'free', status: 'explicit-zero', reasons: [] },
    { model: 'missing', status: 'unpriced', reasons: ['model-rate-unavailable'] },
    { model: 'empty', status: 'unpriced', reasons: ['model-rates-not-configured'] },
    {
      model: 'incomplete',
      status: 'partial',
      reasons: ['input-rate-unavailable', 'output-rate-unavailable'],
    },
    { model: 'no-cache-read', status: 'partial', reasons: ['cache-read-rate-unavailable'] },
    {
      model: 'paid',
      status: 'partial',
      tier: 'bogus',
      reasons: ['service-tier-rate-not-explicit'],
    },
    {
      model: 'paid',
      status: 'partial',
      flags: 0,
      reasons: ['usage-presence-unknown', 'usage-components-unreported'],
    },
    {
      model: 'paid',
      status: 'unavailable',
      flags: 0,
      tokens: zero,
      reasons: ['usage-presence-unknown'],
    },
    {
      model: 'paid',
      status: 'partial',
      flags: complete & ~USAGE_FLAG.breakdownComplete,
      reasons: ['usage-components-unreported'],
    },
    { model: 'paid', status: 'partial', recordKind: 0, reasons: ['legacy-record-kind-unknown'] },
  ] as const;
  f.insert(
    cases.map((c, i) =>
      event(i, {
        billingModel: c.model,
        model: c.model,
        requestedModel: c.model,
        tier: 'tier' in c ? c.tier : 'standard',
        usageFlags: 'flags' in c ? c.flags : complete,
        ...('tokens' in c ? { tokens: c.tokens } : {}),
        recordKind: 'recordKind' in c ? c.recordKind : 1,
      })
    )
  );
  const response = queryAnalytics(f.db, query(), rateState(rateBook));
  for (const [i, c] of cases.entries()) {
    const row = response.requests.items.find((r) => r.execution_id === event(i).executionId)!;
    expect(row.cost, `case ${i}`).toMatchObject({ status: c.status, reasons: [...c.reasons] });
  }
  expect(response.summary.cost).toMatchObject({
    status: 'partial',
    priced_calls: 9,
    unpriced_calls: 2,
  });
  // Unknown presence remains a limitation even when positive counters price its group subtotal.
  expect(response.summary.cost.reasons).toContain('usage-presence-unknown');
});
