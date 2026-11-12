import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryAnalytics } from '../server/usage/analytics';
import { bandLayout, HOUR_MS } from '../server/usage/aggregate';
import { canReadRollup } from '../server/usage/rollupRead';
import { parseRateBook } from '../server/usage/rates';
import { analyticsStore, BASE, event, query, rates, rateState } from './helpers/usageAnalytics';

let fixture: ReturnType<typeof analyticsStore>;
afterEach(() => fixture?.close());
const setup = () => (fixture = analyticsStore());
const start = Math.floor(BASE / HOUR_MS) * HOUR_MS;
const clock = start + 80 * HOUR_MS + 123;
const book = parseRateBook({
  version: 1,
  models: {
    'claude-test-4': {
      ...rates,
      context_tiers: [
        { ...rates, input: 3, above_input_tokens: 1000 },
        { ...rates, input: 9, above_input_tokens: 2000 },
      ],
      service_tiers: [{ ...rates, output: 11, names: ['priority', 'fast'] }],
    },
    free: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    unknown: { input: null, output: null, cache_read: null, cache_write: null },
  },
});
function drain(f: ReturnType<typeof analyticsStore>, now = clock, value = book) {
  let jobs = 0;
  while (f.store.rebuildNextHour(value, now)) {
    if (++jobs > 2000) throw new Error('Rollup failed to drain');
  }
  return jobs;
}
function equal(f: ReturnType<typeof analyticsStore>, patch = {}, value = book, now = clock) {
  const q = query({ from_ms: start, to_ms: clock, ...patch });
  const expected = queryAnalytics(f.db, { ...q, debug_force_raw: true }, rateState(value), {
    now: () => now,
  });
  const actual = queryAnalytics(f.db, q, rateState(value), { now: () => now });
  // No float tolerance, normalization, reason sorting, or omission of response fields.
  expect(actual).toEqual(expected);
  return actual;
}

test.each([195873, 78197, 20261112, 4294967295])(
  'rollup and raw AnalyticsResponse documents are exactly equal on randomized store %i',
  (initialSeed) => {
    const f = setup();
    let seed = initialSeed;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const events = Array.from({ length: 4000 }, (_, i) => {
      const input = [0, 500, 1000, 1001, 2000, 2001][random(6)];
      return event(i, {
        tsMs: start + random(81 * HOUR_MS),
        model: ['client-claude', 'free', 'unknown', 'missing'][random(4)],
        billingModel: ['claude-test-4', 'free', 'unknown', 'missing'][random(4)],
        requestedModel: ['claude-test-4', 'free', 'missing'][random(3)],
        provider: ['claude', 'codex', 'other'][random(3)],
        tier: ['standard', 'priority', 'fast', 'unconfigured'][random(4)],
        usageFlags: [0, 1, 127, 255, 511][random(5)],
        recordKind: [0, 1, 2][random(3)] as 0 | 1 | 2,
        failed: random(4) === 0,
        latencyMs: [null, 1, 77, 9999, 2147483647][random(5)],
        ttftMs: [null, 0, 1, 123, 1000][random(5)],
        tokens: {
          inputTotal: input,
          inputUncached: Math.max(input - 100, 0),
          cacheRead: input ? 80 : 0,
          cacheWrite: input ? 20 : 0,
          outputTotal: 37,
          reasoning: 11,
          total: input + 37,
        },
      });
    });
    f.insert(events.slice(0, 3000));
    f.insert(events.slice(3000), 2);
    drain(f);
    expect(
      f.db.query<{ n: number }, []>('SELECT count(*) AS n FROM usage_hour_rollup').get()!.n
    ).toBeGreaterThan(500);
    // Touch old clean hours via both late traffic and historical imports; keep them dirty.
    f.insert([event(5001, { tsMs: start + HOUR_MS + 12 })]);
    f.insert([event(5002, { tsMs: start + 19 * HOUR_MS + 1 })], 2);
    f.store.recordGap({
      instance: 'test',
      fromMs: start + 9,
      toMs: start + 12,
      reason: 'subscription-dropped',
    });
    f.store.setMeta('retention_floor_ms', String(start + 5));
    for (const granularity of ['day', 'hour']) {
      for (const bounds of [
        { from_ms: start, to_ms: clock },
        { from_ms: start + 1973, to_ms: start + 79 * HOUR_MS + 2345 },
        { from_ms: start + HOUR_MS - 1, to_ms: start + 3 * HOUR_MS + 1 },
      ]) {
        const first = equal(f, { granularity, ...bounds, limit: 7 });
        equal(f, {
          granularity,
          ...bounds,
          limit: 7,
          before_ms: first.requests.next_before_ms,
          before_id: first.requests.next_before_id,
        });
      }
    }
    drain(f);
    equal(f, { granularity: 'day' });
    equal(f, { granularity: 'hour' });
  }
);

test('whole-hour rebuilds replace rather than increment; duplicates leave clean hours clean', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 }), event(2, { tsMs: start + 2 })]);
  drain(f);
  const before = f.db.query('SELECT * FROM usage_hour_rollup').all();
  expect(before).toHaveLength(1);
  f.insert([event(1, { tsMs: start + 1 })], 2);
  expect(f.db.query('SELECT dirty FROM usage_hour_state').get()).toEqual({ dirty: 0 });
  expect(drain(f)).toBe(0);
  f.insert([event(3, { tsMs: start + 3 })], 2);
  expect(f.db.query('SELECT dirty FROM usage_hour_state').get()).toEqual({ dirty: 1 });
  expect(equal(f).summary.calls).toBe(3);
  drain(f);
  expect(equal(f).summary.calls).toBe(3);
  const row = f.db
    .query<{ calls: number; latencies: Uint8Array }, []>(
      'SELECT calls, latencies FROM usage_hour_rollup'
    )
    .get()!;
  expect(row.calls).toBe(3);
  expect(row.latencies.byteLength).toBe(12);
});

test('rate-only edits reuse bands; thresholds and model membership safely invalidate them', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 })]);
  drain(f);
  const repriced = parseRateBook({
    ...book,
    models: { ...book.models, 'claude-test-4': { ...book.models['claude-test-4'], output: 19 } },
  });
  expect(bandLayout(repriced)).toBe(bandLayout(book));
  equal(f, {}, repriced);
  const changed = parseRateBook({
    ...book,
    models: {
      ...book.models,
      'client-claude': {
        ...rates,
        context_tiers: [{ ...rates, input: 10, above_input_tokens: 10 }],
      },
      'claude-test-4': {
        ...rates,
        context_tiers: [{ ...rates, input: 13, above_input_tokens: 20 }],
      },
    },
  });
  expect(bandLayout(changed)).not.toBe(bandLayout(book));
  equal(f, {}, changed);
  drain(f, clock, changed);
  equal(f, {}, changed);
});

test('filters, search and debug force the entire response to raw; strict debug boundary', () => {
  for (const patch of [
    { provider: 'codex' },
    { model: 'x' },
    { outcome: 'failed' },
    { search: '%' },
    { debug_force_raw: true },
  ])
    expect(canReadRollup(query(patch))).toBe(false);
  expect(canReadRollup(query())).toBe(true);
  expect(() => query({ debug_force_raw: 'true' })).toThrow();
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 })]);
  drain(f);
  // Corruption is synthetic and proves these responses never consume the rollup.
  const writer = new Database(f.path);
  writer.exec('UPDATE usage_hour_rollup SET calls = 999');
  writer.close();
  for (const patch of [
    { provider: 'claude' },
    { model: 'client-claude' },
    { outcome: 'success' },
    { search: '%' },
    { debug_force_raw: true },
  ])
    expect(equal(f, patch).summary.calls).toBe(1);
});

test('open hours, partial hours and timings beyond int32 stay raw without loss', () => {
  const f = setup();
  f.insert([
    event(1, { tsMs: start + 1, latencyMs: 2147483648, ttftMs: 2147483649 }),
    event(2, { tsMs: start + 80 * HOUR_MS + 1 }),
    event(3, { tsMs: start + HOUR_MS - 1, latencyMs: 3 }),
  ]);
  drain(f);
  expect(
    f.db.query('SELECT supported, dirty FROM usage_hour_state WHERE hour_ms = ?').get(start)
  ).toEqual({ supported: 0, dirty: 0 });
  expect(
    f.db.query('SELECT dirty FROM usage_hour_state WHERE hour_ms = ?').get(start + 80 * HOUR_MS)
  ).toEqual({ dirty: 1 });
  expect(equal(f).summary.p95_latency_ms).toBe(2147483648);
  equal(f, { from_ms: start + 2, to_ms: start + HOUR_MS - 1 });
  drain(f, start + 81 * HOUR_MS);
  equal(f, {}, book, start + 81 * HOUR_MS);
});

test('pre-migration events are discovered one hour per job without a startup table rewrite', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 }), event(2, { tsMs: start + 100 * HOUR_MS })]);
  const writer = new Database(f.path);
  writer.exec('DELETE FROM usage_hour_state'); // Simulate migration 1 events without dirty marks.
  writer.close();
  expect(f.store.rebuildNextHour(book, start + 102 * HOUR_MS)?.hour).toBe(start);
  expect(f.db.query('SELECT count(*) AS n FROM usage_hour_state').get()).toEqual({ n: 1 });
  expect(f.store.rebuildNextHour(book, start + 102 * HOUR_MS)?.hour).toBe(start + 100 * HOUR_MS);
  expect(f.store.rebuildNextHour(book, start + 102 * HOUR_MS)).toBeNull();
});

test('invalidation and replacement roll back atomically on write failure', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 })]);
  drain(f);
  const writer = new Database(f.path);
  writer.exec(
    "CREATE TRIGGER fail_dirty BEFORE UPDATE ON usage_hour_state BEGIN SELECT RAISE(ABORT, 'test'); END"
  );
  expect(() => f.insert([event(2, { tsMs: start + 2 })])).toThrow();
  expect(equal(f).summary.calls).toBe(1);
  writer.exec('DROP TRIGGER fail_dirty');
  f.insert([event(2, { tsMs: start + 2 })]);
  const old = f.db.query('SELECT * FROM usage_hour_rollup').all();
  writer.exec(
    "CREATE TRIGGER fail_rollup BEFORE INSERT ON usage_hour_rollup BEGIN SELECT RAISE(ABORT, 'test'); END"
  );
  expect(() => f.store.rebuildNextHour(book, clock)).toThrow();
  expect(f.db.query('SELECT * FROM usage_hour_rollup').all()).toEqual(old);
  expect(f.db.query('SELECT dirty FROM usage_hour_state').get()).toEqual({ dirty: 1 });
  expect(equal(f).summary.calls).toBe(2);
  writer.close();
});

test('thousands of imported hours drain one replacement per job', () => {
  const f = setup();
  f.insert(
    Array.from({ length: 3000 }, (_, i) => event(i, { tsMs: start + i * HOUR_MS + 1 })),
    2
  );
  const now = start + 3001 * HOUR_MS;
  expect(f.store.rebuildNextHour(book, now)?.hour).toBe(start);
  expect(f.db.query('SELECT count(*) AS n FROM usage_hour_state WHERE dirty = 1').get()).toEqual({
    n: 2999,
  });
  expect(f.db.query('SELECT count(*) AS n FROM usage_hour_rollup').get()).toEqual({ n: 1 });
  equal(f, { to_ms: start + 30 * 86400000 }, book, now);
});

test('coverage retains imported unknown providers even when they have only supplementary records', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1, provider: 'supplementary-only', recordKind: 2 })], 2);
  drain(f);
  const response = equal(f);
  expect(response.summary.calls).toBe(0);
  expect(response.coverage.limitations.join('\n')).toContain('imported');
  expect(response.coverage.limitations.join('\n')).toContain('unknown provider');
});

test('a late insert during a hybrid response cannot replace its pinned hour or leak into detail', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 })]);
  drain(f);
  const q = query({ from_ms: start, to_ms: clock });
  const before = queryAnalytics(f.db, q, rateState(book), { now: () => clock });
  const during = queryAnalytics(f.db, q, rateState(book), {
    now: () => clock,
    afterAggregate: () => f.insert([event(2, { tsMs: start + 2, latencyMs: 999999 })], 2),
  });
  expect(during).toEqual(before);
  expect(equal(f).summary.calls).toBe(2);
});

test('SQLite sample merging preserves arbitrary int32 bytes without text decoding', () => {
  const f = setup();
  const values = Array.from(
    { length: 512 },
    (_, i) => 1 + ((Math.imul(i + 1, 2654435761) >>> 0) >>> 1)
  );
  f.insert(
    values.map((latencyMs, i) =>
      event(i, {
        tsMs: start + i + 1,
        latencyMs,
        ttftMs: latencyMs,
        tier: i % 2 ? 'priority' : 'standard',
        failed: i % 7 === 0,
      })
    )
  );
  drain(f);
  const response = equal(f);
  expect(response.summary.p95_latency_ms).toBe(
    values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  );
  expect(response.summary.p95_ttft_ms).toBe(response.summary.p95_latency_ms);
});

test('P3 importChunk invalidates rollups in the same transaction as rows and its cursor', () => {
  const f = setup();
  f.insert([event(1, { tsMs: start + 1 })]);
  drain(f);
  f.store.importChunk([event(2, { tsMs: start + 2 })], 100);
  expect(f.store.getMeta('import:cpamp:last_id')).toBe('100');
  expect(f.db.query('SELECT dirty FROM usage_hour_state').get()).toEqual({ dirty: 1 });
  expect(equal(f).summary.calls).toBe(2);
  drain(f);
  equal(f);
});
