import { describe, expect, test } from 'bun:test';
import {
  buildRateInventory,
  combineEstimates,
  contextBand,
  createAggregateCostEstimator,
  estimateAggregateCost,
  estimateCost,
  resolveModelPrice,
  type PricingGroup,
} from '../server/usage/pricing';
import { parseRateBook } from '../server/usage/rates';
import { RECORD_KIND, USAGE_FLAG } from '../server/usage/types';

const rates = { input: 2, output: 4, cache_read: 0.5, cache_write: null };
const complete = Object.values(USAGE_FLAG).reduce((a, b) => a | b, 0);
const book = parseRateBook({
  version: 1,
  models: {
    paid: rates,
    alias: { ...rates, input: 7, output: 8 },
    free: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    empty: { input: null, output: null, cache_read: null, cache_write: null },
    'claude-fable-5-2': {
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      source: 'pending D5',
    },
    'gpt-6.1-terra': {
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      source: 'pending D5',
    },
  },
});
function group(overrides: Partial<PricingGroup> = {}): PricingGroup {
  return {
    model: 'paid',
    usageFlags: complete,
    recordKind: RECORD_KIND.execution,
    tokens: {
      inputTotal: 1_000_000,
      inputUncached: 500_000,
      cacheRead: 300_000,
      cacheWrite: 200_000,
      outputTotal: 100_000,
      reasoning: 1000,
      total: 1_100_000,
    },
    ...overrides,
  };
}
const zero: PricingGroup['tokens'] = {
  inputTotal: 0,
  inputUncached: 0,
  cacheRead: 0,
  cacheWrite: 0,
  outputTotal: 0,
  reasoning: 0,
  total: 0,
};

describe('CPAMP analytics estimate availability and reasons', () => {
  test('missing, unconfigured, free and measured-zero are distinct', () => {
    for (const [model, status, reason] of [
      ['missing', 'unpriced', 'model-rate-unavailable'],
      ['empty', 'unpriced', 'model-rates-not-configured'],
      ['claude-fable-5-2', 'unpriced', 'model-rates-not-configured'],
      ['gpt-6.1-terra', 'unpriced', 'model-rates-not-configured'],
    ]) {
      expect(estimateCost(group({ model }), book)).toMatchObject({
        usd: null,
        status,
        reasons: [reason],
      });
    }
    expect(estimateCost(group({ model: 'free' }), book)).toMatchObject({
      usd: 0,
      status: 'explicit-zero',
      reasons: [],
    });
    expect(estimateCost(group({ tokens: zero }), book)).toMatchObject({
      usd: 0,
      status: 'estimated',
      reasons: [],
    });
    expect(estimateCost(group({ tokens: zero, usagePresent: null }), book)).toMatchObject({
      usd: null,
      status: 'unavailable',
      reasons: ['usage-presence-unknown'],
    });
    expect(estimateCost(group({ usagePresent: false }), book)).toMatchObject({
      usd: null,
      status: 'unavailable',
      reasons: ['usage-not-reported'],
    });
    expect(estimateCost(group({ calls: 0 }), book)).toEqual({
      usd: null,
      status: 'unavailable',
      reasons: ['no-retained-events'],
    });
  });
  test('known subtotal and ordered reasons survive missing rates', () => {
    const incomplete = parseRateBook({
      version: 1,
      models: { paid: { input: null, output: null, cache_read: 0.5, cache_write: null } },
    });
    expect(estimateCost(group(), incomplete)).toMatchObject({
      usd: 0.15,
      status: 'partial',
      reasons: ['input-rate-unavailable', 'output-rate-unavailable'],
    });
    const missingRead = parseRateBook({
      version: 1,
      models: { paid: { ...rates, cache_read: null } },
    });
    expect(estimateCost(group({ tier: 'bogus', usagePresent: null }), missingRead).usd).toBeCloseTo(
      1.8,
      10
    );
    expect(estimateCost(group({ tier: 'bogus', usagePresent: null }), missingRead)).toMatchObject({
      status: 'partial',
      reasons: [
        'usage-presence-unknown',
        'cache-read-rate-unavailable',
        'service-tier-rate-not-explicit',
      ],
    });
    // The absent cache-read rate must never silently fall back to 10% of input.
    const explicitRead = parseRateBook({
      version: 1,
      models: { paid: { ...rates, cache_read: 0 } },
    });
    expect(estimateCost(group(), explicitRead).reasons).toEqual([]);
  });
  test('bit 7 clear always makes a priced estimate partial, even with every presence bit', () => {
    const raw = group({ usageFlags: complete & ~USAGE_FLAG.breakdownComplete });
    raw.tokens = { ...raw.tokens, inputUncached: raw.tokens.inputTotal };
    expect(estimateCost(raw, book)).toMatchObject({
      status: 'partial',
      reasons: ['usage-components-unreported'],
    });
    expect(
      estimateCost(group({ usageFlags: complete & ~USAGE_FLAG.cacheReadTokens }), book).reasons
    ).toEqual(['usage-components-unreported']);
    expect(
      estimateCost(group({ usageFlags: complete & ~USAGE_FLAG.fieldsPresent }), book).reasons
    ).toEqual(['usage-components-unreported']);
    expect(
      estimateCost(group({ usageFlags: complete & ~USAGE_FLAG.presenceReported }), book).reasons
    ).toEqual(['usage-presence-unknown']);
  });
  test('unknown and supplementary record kinds preserve CPAMP reason strings', () => {
    expect(estimateCost(group({ recordKind: RECORD_KIND.unknown }), book)).toMatchObject({
      status: 'partial',
      reasons: ['legacy-record-kind-unknown'],
    });
    expect(estimateCost(group({ recordKind: RECORD_KIND.supplementary }), book)).toMatchObject({
      status: 'partial',
      reasons: ['supplementary-overlap-unknown'],
    });
  });
  test('candidates are billing, model, requested; trim names and never guess aliases', () => {
    expect(estimateCost(group({ billingModel: ' alias ' }), book).usd).toBeCloseTo(5.85, 10);
    expect(
      estimateCost(group({ billingModel: 'missing', requestedModel: 'alias' }), book).usd
    ).toBeCloseTo(1.95, 10);
    expect(
      estimateCost(
        group({ billingModel: 'missing', model: 'absent', requestedModel: 'alias' }),
        book
      ).usd
    ).toBeCloseTo(5.85, 10);
    expect(resolveModelPrice(['', 'missing', ' paid '], book)?.matchedModel).toBe('paid');
    // Built-in GPT prices are deliberately absent.
    expect(estimateCost(group({ model: 'gpt-5.6-sol' }), book).reasons).toEqual([
      'model-rate-unavailable',
    ]);
  });
});

describe('CPAMP retained cost branches', () => {
  test('cache writes use input by default, explicit zero stays zero, output includes reasoning once', () => {
    expect(estimateCost(group(), book).usd).toBeCloseTo(1.95, 10);
    for (const [cache_write, expected] of [
      [2.5, 2.05],
      [0, 1.55],
    ]) {
      const configured = parseRateBook({ version: 1, models: { paid: { ...rates, cache_write } } });
      expect(estimateCost(group(), configured).usd).toBeCloseTo(expected, 10);
    }
  });
  test('highest strictly exceeded context tier wins before service, with null fields inheriting base', () => {
    const tiered = parseRateBook({
      version: 1,
      models: {
        paid: {
          ...rates,
          context_tiers: [
            { ...rates, above_input_tokens: 200, input: 8, output: null, cache_read: null },
            { ...rates, above_input_tokens: 100, input: 4 },
          ],
          service_tiers: [
            {
              input: 20,
              output: 40,
              cache_read: null,
              cache_write: null,
              names: ['fast', 'priority'],
            },
          ],
        },
      },
    });
    const price = tiered.models.paid;
    expect(contextBand(price, 100)).toBeNull();
    expect(contextBand(price, 200)).toBe(100);
    expect(contextBand(price, 201)).toBe(200);
    const input = (inputTotal: number) => ({ ...zero, inputTotal, inputUncached: inputTotal });
    expect(estimateCost(group({ tier: 'priority', tokens: input(100) }), tiered).usd).toBeCloseTo(
      0.002,
      10
    );
    expect(estimateCost(group({ tier: 'fast', tokens: input(200) }), tiered).usd).toBeCloseTo(
      0.0008,
      10
    );
    expect(estimateCost(group({ tier: 'priority', tokens: input(201) }), tiered).usd).toBeCloseTo(
      0.001608,
      10
    );
    // CPAMP flags a non-explicit service tier even when a context tier owns the cost.
    expect(estimateCost(group({ tier: 'turbo', tokens: input(201) }), tiered).reasons).toEqual([
      'service-tier-rate-not-explicit',
    ]);
    // SQL sums in the base band must not cross a request threshold again.
    expect(
      estimateCost(group({ contextThreshold: null, tier: ' PRIORITY ' }), tiered).usd
    ).toBeCloseTo(18.15, 10);
    expect(
      estimateCost(group({ contextThreshold: 200, tier: 'priority' }), tiered).usd
    ).toBeCloseTo(6.15, 10);
    expect(() => estimateCost(group({ contextThreshold: 999 }), tiered)).toThrow(
      'Unknown context band'
    );
    expect(() => estimateCost(group({ calls: 2 }), tiered)).toThrow(
      'Aggregate pricing requires an explicit per-event context band'
    );
  });
  test('no implicit service multipliers or built-in long-context premiums', () => {
    for (const tier of ['priority', 'fast', 'flex', 'batch']) {
      const value = estimateCost(group({ tier }), book);
      expect(value.usd).toBeCloseTo(1.95, 10);
      expect(value.reasons).toEqual(['service-tier-rate-not-explicit']);
    }
    for (const tier of ['', 'default', ' STANDARD '])
      expect(estimateCost(group({ tier }), book).status).toBe('estimated');
  });
  test('within each context band and tier, pricing sums equals the sum of prices', () => {
    const one = group({ contextThreshold: null });
    const doubled = { ...one.tokens };
    for (const key of Object.keys(doubled) as Array<keyof typeof doubled>) doubled[key] *= 2;
    expect(
      estimateCost(group({ tokens: doubled, contextThreshold: null, calls: 2 }), book).usd
    ).toBeCloseTo(estimateCost(one, book).usd! * 2, 10);
  });
  test('combine known and unknown costs, deduplicate reasons, preserve counts without mutation', () => {
    const known = estimateCost(group({ calls: 3, usagePresent: null }), book);
    const unknown = estimateCost(group({ model: 'missing', calls: 2 }), book);
    const combined = combineEstimates(known, unknown);
    expect(combined).toMatchObject({
      usd: known.usd,
      status: 'partial',
      priced_calls: 3,
      unpriced_calls: 2,
      reasons: ['usage-presence-unknown', 'model-rate-unavailable'],
    });
    expect(combineEstimates(combined, unknown).reasons).toEqual(combined.reasons);
    expect(known.reasons).toEqual(['usage-presence-unknown']);
    expect(combineEstimates(unknown, unknown).status).toBe('unpriced');
    expect(
      combineEstimates(
        estimateCost(group({ model: 'free' }), book),
        estimateCost(group({ model: 'free' }), book)
      ).status
    ).toBe('estimated');
  });
  test('reject unsafe, negative and fractional token sums', () => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      expect(() => estimateCost(group({ tokens: { ...zero, inputTotal: value } }), book)).toThrow();
    }
  });
});

test('rate inventory preserves catalog order, deduplicates exact registration, then sorted observed identities', () => {
  const entry = { instance_id: 'one', instance_label: 'One', provider: 'codex', id: 'paid' };
  const inventory = buildRateInventory(
    [entry, entry, { ...entry, instance_id: 'two' }],
    [
      { provider: 'codex', id: 'paid' },
      { provider: 'claude', id: 'missing' },
      { provider: 'claude', id: 'free' },
      { provider: 'claude', id: 'free' },
      { provider: 'claude', id: 'empty' },
    ],
    book
  );
  expect(inventory.map((row) => [row.id, row.registered])).toEqual([
    ['paid', true],
    ['paid', true],
    ['empty', false],
    ['free', false],
    ['missing', false],
  ]);
  expect(inventory[0]).toMatchObject({
    matched_model: 'paid',
    status: 'priced',
    cache_write_per_million: null,
    source: 'configured-or-owner-fallback',
  });
  expect(inventory[2]).toMatchObject({ status: 'unpriced', input_per_million: null });
  expect(inventory[3]).toMatchObject({ status: 'priced', input_per_million: 0 });
  expect(inventory[4]).toMatchObject({
    status: 'unpriced',
    matched_model: null,
    source: 'unavailable',
  });
});

test('prepared aggregate schedules preserve exact estimates across bands, tiers and book snapshots', () => {
  const value = parseRateBook({
    version: 1,
    models: {
      ...book.models,
      paid: {
        ...rates,
        context_tiers: [{ ...rates, input: 7.31, above_input_tokens: 1000 }],
        service_tiers: [{ ...rates, output: 0, names: ['priority', 'fast'] }],
      },
    },
  });
  const estimate = createAggregateCostEstimator(value);
  for (let repeat = 0; repeat < 3; repeat++)
    for (const model of ['paid', 'free', 'empty', 'missing'])
      for (const tier of ['standard', 'priority', 'fast', 'unknown'])
        for (const band of model === 'paid' ? [null, 1000] : [null])
          for (const tokens of [zero, group().tokens]) {
            const input = group({ model, tier, tokens, calls: repeat + 1, contextThreshold: band });
            expect(estimate(input)).toEqual(estimateAggregateCost(input, value));
          }
  const revised = parseRateBook({
    ...value,
    models: { ...value.models, paid: { ...value.models.paid, input: 11 } },
  });
  const input = group({ contextThreshold: null, calls: 3 });
  expect(createAggregateCostEstimator(revised)(input)).toEqual(
    estimateAggregateCost(input, revised)
  );
  expect(createAggregateCostEstimator(revised)(input).usd).not.toBe(estimate(input).usd);
});
