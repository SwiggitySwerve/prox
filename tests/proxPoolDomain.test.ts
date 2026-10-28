import { describe, expect, test } from 'bun:test';
import { buildDashboard, measuredRates, projectPool } from '../server/quota/domain';
import type { DashboardOptions } from '../server/quota/domain';
import type { QuotaSample, StoredAccount } from '../server/quota/types';
import { HOUR_MS, STALE_MS } from '../server/quota/types';

const now = Date.UTC(2026, 9, 27, 12);
const account = (id = 'a', patch: Partial<StoredAccount> = {}): StoredAccount => ({
  id,
  provider: 'claude',
  name: 'private-file.json',
  email: 'private@example.test',
  disabled: false,
  retired: false,
  lastSeenAtMs: now,
  lastErrorAtMs: null,
  ...patch,
});
const sample = (at: number, remaining: number, patch: Partial<QuotaSample> = {}): QuotaSample => ({
  accountId: 'a',
  window: 'weekly',
  observedAtMs: at,
  remainingPercent: remaining,
  resetAtMs: now + HOUR_MS,
  periodHours: 168,
  ...patch,
});
const options: DashboardOptions = {
  nowMs: now,
  window: 'weekly',
  lookbackHours: 3,
  multiplier: 1,
  offsetDays: 0,
  reveal: false,
};
const collection = {
  historyStartedAtMs: now,
  lastRefreshAtMs: now,
  nextRefreshAtMs: now + 300_000,
  refreshing: false,
  issues: [],
};
const dashboard = (
  accounts: StoredAccount[],
  samples: QuotaSample[],
  patch: Partial<DashboardOptions> = {}
) => buildDashboard(accounts, samples, { ...options, ...patch }, collection);

describe('measured quota rates', () => {
  test('requires actual observation span, not a fresh balance', () => {
    expect(measuredRates([sample(now, 60)], now, 3).burn).toBeNull();
    expect(measuredRates([sample(now - 60_000, 61), sample(now, 60)], now, 3).burn).toBeNull();
    expect(measuredRates([sample(now - 600_000, 70), sample(now, 60)], now, 3).burn).toBe(60);
  });
  test('resets replenish drain but never produce negative burn', () => {
    const points = [sample(now - 600_000, 10, { resetAtMs: now - 300_000 }), sample(now, 95)];
    expect(measuredRates(points, now, 3)).toEqual({ burn: null, drain: -510 });
  });
  test('outages, future samples and stale samples do not become known rates', () => {
    expect(
      measuredRates([sample(now - STALE_MS - 1, 80), sample(now, 50)], now, 3).burn
    ).toBeNull();
    expect(measuredRates([sample(now - 600_000, 80), sample(now + 1, 50)], now, 3).burn).toBeNull();
    expect(
      measuredRates([sample(now - 1_800_000, 80), sample(now - 1_200_000, 50)], now, 3).burn
    ).toBeNull();
  });
});

describe('pooled forecast scenarios', () => {
  test('fractional depletion instants finish without timestamp-rounding loops', () => {
    const samples = [sample(now - 600_000, 67), sample(now, 14)];
    const pool = dashboard([account()], samples).pools[0];
    expect(pool.forecastState).toBe('ready');
    expect(pool.firstEmptyAtMs).toBeCloseTo(now + (14 / 318) * HOUR_MS, 0);
    expect(pool.projected.some((point) => point.remainingPoints === 0)).toBe(true);
    const tiny = projectPool(
      [{ remaining: 2e-8, rate: 600, resetAtMs: now + HOUR_MS, periodHours: 5, capacity: 100 }],
      now,
      now + HOUR_MS
    );
    expect(tiny.poolEmptyAtMs).toBe(now);
    expect(tiny.points.at(-1)?.remainingPoints).toBe(100);
  });
  test('records reset jumps at the same instant and caps each account at 100', () => {
    const result = projectPool(
      [{ remaining: 50, rate: 10, resetAtMs: now + HOUR_MS, periodHours: 5, capacity: 100 }],
      now,
      now + 2 * HOUR_MS
    );
    expect(result.resets).toEqual([{ atMs: now + HOUR_MS, gainPoints: 60 }]);
    expect(
      result.points.filter((p) => p.atMs === now + HOUR_MS).map((p) => p.remainingPoints)
    ).toEqual([40, 100]);
    expect(result.points.at(-1)?.remainingPoints).toBe(90);
    expect(result.poolEmptyAtMs).toBeNull();
  });
  test('distinguishes first account empty from the entire pool empty', () => {
    const result = projectPool(
      [
        { remaining: 10, rate: 10, resetAtMs: now + 5 * HOUR_MS, periodHours: 168, capacity: 100 },
        { remaining: 40, rate: 20, resetAtMs: now + 5 * HOUR_MS, periodHours: 168, capacity: 100 },
      ],
      now,
      now + 3 * HOUR_MS
    );
    // Fill-first: the pool's 30/h drains A (10) in 20 minutes, then B (40) by 100 minutes.
    expect(result.firstEmptyAtMs).toBe(now + HOUR_MS / 3);
    expect(result.poolEmptyAtMs).toBe(now + (5 * HOUR_MS) / 3);
    expect(result.points.every((p) => (p.remainingPoints ?? 0) >= 0)).toBe(true);
  });
  test('fill-first: pool demand moves to whichever account has quota, soonest reset first', () => {
    // Two drained accounts and one serving all traffic, as on the live Claude pool.
    const result = projectPool(
      [
        { remaining: 0, rate: 0, resetAtMs: now + 19 * HOUR_MS, periodHours: 168, capacity: 2000 },
        { remaining: 0, rate: 0, resetAtMs: now + 84 * HOUR_MS, periodHours: 168, capacity: 2000 },
        { remaining: 420, rate: 54, resetAtMs: now + 138 * HOUR_MS, periodHours: 168, capacity: 2000 },
      ],
      now,
      now + 150 * HOUR_MS
    );
    const at = (hours: number) =>
      result.points.filter((p) => p.atMs <= now + hours * HOUR_MS).at(-1)?.remainingPoints;
    expect(result.poolEmptyAtMs).toBeCloseTo(now + (420 / 54) * HOUR_MS, -3);
    // The first account's reset is consumed at the pool's burn rate, not left idle.
    expect(at(29)).toBeCloseTo(2000 - 54 * 10, 6);
    expect(at(84 - 0.01)).toBe(0);
    expect(at(94)).toBeCloseTo(2000 - 54 * 10, 6);
    expect(result.resets.map((r) => r.gainPoints)).toEqual([2000, 2000, 2000]);
  });
  test('idle retains remaining balance until the observed reset', () => {
    const result = projectPool(
      [{ remaining: 30, rate: 0, resetAtMs: now + HOUR_MS, periodHours: 168, capacity: 100 }],
      now,
      now + 2 * HOUR_MS
    );
    expect(result.poolEmptyAtMs).toBeNull();
    expect(result.points.at(-1)?.remainingPoints).toBe(100);
    expect(result.resets[0].gainPoints).toBe(70);
  });
});

describe('dashboard evidence and privacy', () => {
  test('normalizes enabled accounts once and keeps providers separate', () => {
    const result = dashboard(
      [account(), account('b', { provider: 'codex' }), account('disabled', { disabled: true })],
      [
        sample(now, 50),
        sample(now, 80, { accountId: 'b' }),
        sample(now, 100, { accountId: 'disabled' }),
      ]
    );
    expect(result.pools.map((p) => [p.remainingPoints, p.capacityPoints])).toEqual([
      [50, 100],
      [80, 100],
    ]);
    expect(result.pools[0].forecastState).toBe('collecting');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(
      dashboard([account()], [sample(now, 50)], { reveal: true }).pools[0].accounts[0].email
    ).toBe('private@example.test');
  });
  test('missing windows and stale balances are unknown, not zero', () => {
    expect(dashboard([account()], []).pools[0].remainingPoints).toBeNull();
    const stale = dashboard([account()], [sample(now - STALE_MS - 1, 50)]).pools[0];
    expect(stale.remainingPoints).toBeNull();
    expect(stale.forecastState).toBe('stale');
    expect(stale.projected).toEqual([]);
  });
  test('expired windows are unknown until another successful observation', () => {
    const pool = dashboard([account()], [sample(now, 2, { resetAtMs: now })]).pools[0];
    expect(pool.remainingPoints).toBeNull();
    expect(pool.nextResetAtMs).toBeNull();
  });
  test('missing observations immediately supersede balances and break rate intervals', () => {
    const samples = [sample(now - 600_000, 60), sample(now, 0, { remainingPercent: null })];
    const pool = dashboard([account()], samples).pools[0];
    expect(pool.remainingPoints).toBeNull();
    expect(pool.accounts[0].status).toBe('missing-window');
    expect(pool.recorded.at(-1)?.remainingPoints).toBeNull();
    expect(measuredRates(samples, now, 3)).toEqual({ burn: null, drain: null });
    expect(measuredRates([sample(now - 1_200_000, 80), ...samples], now, 3)).toEqual({
      burn: null,
      drain: null,
    });
    expect(
      dashboard([account()], [...samples, sample(now + 1, 50)], { nowMs: now + 1 }).pools[0]
        .remainingPoints
    ).toBe(50);
  });
  test('weekly and five-hour windows are never combined', () => {
    const result = dashboard(
      [account()],
      [sample(now, 50), sample(now, 80, { window: 'five-hour' })],
      { window: 'five-hour' }
    );
    expect(result.pools[0].remainingPoints).toBe(80);
  });
  test('complete observations enable forecasts, incomplete account sets suppress them', () => {
    const samples = [sample(now - 600_000, 60), sample(now, 50)];
    expect(dashboard([account()], samples).pools[0].forecastState).toBe('ready');
    expect(dashboard([account(), account('missing')], samples).pools[0].projected).toEqual([]);
    expect(
      dashboard([account('a', { lastErrorAtMs: now })], samples).pools[0].remainingPoints
    ).toBeNull();
  });
  test('inventory failure preserves uncertainty even when previous quota samples are current', () => {
    const result = buildDashboard([account()], [sample(now, 50)], options, {
      ...collection,
      issues: [{ provider: 'claude', code: 'inventory-unavailable' }],
    });
    expect(result.pools[0].remainingPoints).toBeNull();
    expect(result.pools[0].forecastState).toBe('partial');
  });
  test('accounts carry their latest reported windows and nothing extra leaks', () => {
    const fiveHour = {
      id: 'five-hour',
      labelKey: 'claude_quota.five_hour',
      remainingPercent: 30,
      resetAtMs: now + HOUR_MS,
    };
    const result = buildDashboard([account()], [sample(now, 50)], options, {
      ...collection,
      windows: new Map([[account().id, [fiveHour]]]),
    });
    expect(result.pools[0].accounts[0].windows).toEqual([fiveHour]);
    expect('windows' in result).toBe(false);
    expect(dashboard([account()], [sample(now, 50)]).pools[0].accounts[0].windows).toEqual([]);
  });
  test('recorded histories break across outages', () => {
    const recorded = dashboard([account()], [sample(now - HOUR_MS, 80), sample(now, 50)]).pools[0]
      .recorded;
    expect(recorded).toHaveLength(3);
    expect(recorded[1].remainingPoints).toBeNull();
  });
  test('future scenarios scale predictions without changing recorded balances or rates', () => {
    const samples = [sample(now - 600_000, 60), sample(now, 50)];
    const normal = dashboard([account()], samples).pools[0];
    const doubled = dashboard([account()], samples, { multiplier: 2 }).pools[0];
    expect(doubled.recorded).toEqual(normal.recorded);
    expect(doubled.firstEmptyAtMs! - now).toBe((normal.firstEmptyAtMs! - now) / 2);
  });
});
