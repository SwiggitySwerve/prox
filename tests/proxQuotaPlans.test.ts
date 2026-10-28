import { afterEach, describe, expect, test } from 'bun:test';
import { buildDashboard, projectPool } from '../server/quota/domain';
import { planFromClaudeProfile, planFromCodexUsage, planWeight } from '../server/quota/plans';
import { QuotaStore } from '../server/quota/store';
import type { QuotaSample, StoredAccount } from '../server/quota/types';
import { HOUR_MS } from '../server/quota/types';

const now = Date.UTC(2026, 9, 28, 12);
const account = (id: string, provider: 'claude' | 'codex', plan?: string): StoredAccount => ({
  id,
  provider,
  name: `${id}.json`,
  email: null,
  disabled: false,
  retired: false,
  lastSeenAtMs: now,
  lastErrorAtMs: null,
  ...(plan ? { plan } : {}),
});
const samples = (id: string, from: number, to: number): QuotaSample[] =>
  [0, 1, 2].map((step) => ({
    accountId: id,
    window: 'weekly',
    observedAtMs: now - (2 - step) * 600_000,
    remainingPercent: from - ((from - to) * step) / 2,
    resetAtMs: now + 24 * HOUR_MS,
    periodHours: 168,
  }));
const dashboard = (accounts: StoredAccount[], rows: QuotaSample[]) =>
  buildDashboard(
    accounts,
    rows,
    { nowMs: now, window: 'weekly', lookbackHours: 3, multiplier: 1, offsetDays: 0, reveal: false },
    {
      historyStartedAtMs: now,
      lastRefreshAtMs: now,
      nextRefreshAtMs: now,
      refreshing: false,
      issues: [],
    }
  );

describe('plan weights', () => {
  test('use each provider base plan as one unit', () => {
    expect(planWeight('claude', 'default_claude_max_20x')).toEqual({
      multiplier: 20,
      label: 'Max 20x',
      known: true,
    });
    expect(planWeight('claude', 'default_claude_max_5x')).toEqual({
      multiplier: 5,
      label: 'Max 5x',
      known: true,
    });
    expect(planWeight('claude', 'claude_pro')).toEqual({
      multiplier: 1,
      label: 'Pro',
      known: true,
    });
    expect(planWeight('codex', 'plus')).toEqual({ multiplier: 1, label: 'Plus', known: true });
    expect(planWeight('codex', 'pro')).toEqual({ multiplier: 10, label: 'Pro', known: true });
    expect(planWeight('codex', 'promax')).toEqual({
      multiplier: 25,
      label: 'Pro 500',
      known: true,
    });
  });
  test('an unknown or missing plan counts once and says so', () => {
    expect(planWeight('codex', 'enterprise')).toEqual({
      multiplier: 1,
      label: 'enterprise',
      known: false,
    });
    expect(planWeight('claude', undefined)).toEqual({ multiplier: 1, label: null, known: false });
  });
  test('read the plan from provider responses', () => {
    expect(planFromCodexUsage({ plan_type: 'promax', rate_limit: {} })).toBe('promax');
    expect(planFromCodexUsage('{"plan_type":"pro"}')).toBe('pro');
    expect(planFromCodexUsage({})).toBeNull();
    expect(
      planFromClaudeProfile({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      })
    ).toBe('default_claude_max_20x');
    expect(planFromClaudeProfile({ organization: { organization_type: 'claude_pro' } })).toBe(
      'claude_pro'
    );
    expect(planFromClaudeProfile('not json')).toBeNull();
  });
});

describe('weighted pools', () => {
  test('points follow plan weight: Pro 500 counts 2.5 times Pro 200', () => {
    const pool = dashboard(
      [account('research', 'codex', 'promax'), account('normal', 'codex', 'pro')],
      [...samples('research', 50, 40), ...samples('normal', 50, 40)]
    ).pools.find((p) => p.provider === 'codex')!;
    expect(pool.capacityPoints).toBe(3500);
    expect(pool.remainingPoints).toBe(1400); // 40% of 2500 + 40% of 1000
    expect(pool.burnPointsPerHour).toBeCloseTo(1050); // 30%/h of 2500 + 30%/h of 1000
    const research = pool.accounts.find((a) => a.id === 'research')!;
    expect(research.remainingPercent).toBe(40);
    expect(research.plan).toEqual({ label: 'Pro 500', capacityPoints: 2500, known: true });
    expect(pool.recorded.at(-1)?.remainingPoints).toBe(1400);
  });
  test('an account without a known plan stays at 100 points', () => {
    const pool = dashboard([account('a', 'claude')], samples('a', 80, 60)).pools.find(
      (p) => p.provider === 'claude'
    )!;
    expect(pool.capacityPoints).toBe(100);
    expect(pool.accounts[0].plan).toEqual({ label: null, capacityPoints: 100, known: false });
  });
  test('a reset restores each account to its own capacity', () => {
    const { resets } = projectPool(
      [
        { remaining: 500, rate: 0, resetAtMs: now + HOUR_MS, periodHours: 168, capacity: 2500 },
        { remaining: 0, rate: 0, resetAtMs: now + HOUR_MS, periodHours: 168, capacity: 1000 },
      ],
      now,
      now + 2 * HOUR_MS
    );
    expect(resets[0].gainPoints).toBe(3000);
  });
});

describe('plan persistence', () => {
  const stores: QuotaStore[] = [];
  afterEach(() => stores.splice(0).forEach((s) => s.close()));
  test('stores the latest plan per account and lists it', () => {
    const store = new QuotaStore(':memory:');
    stores.push(store);
    store.recordInventory('codex', [account('x', 'codex')], now);
    expect(store.listAccounts()[0].plan).toBeUndefined();
    store.recordPlan('x', 'pro', now);
    store.recordPlan('x', 'promax', now + 1);
    expect(store.listAccounts()[0]).toMatchObject({ plan: 'promax', planObservedAtMs: now + 1 });
  });
});
