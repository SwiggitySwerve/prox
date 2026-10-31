import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, parseOptions } from '../server/app';
import type { QuotaStore } from '../server/quota/store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prox-http-test-'));
  dirs.push(dir);
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'synthetic-test-key', { mode: 0o600 });
  let reads = 0;
  let refreshes = 0;
  const store = {
    listAccounts: () => {
      reads++;
      return [];
    },
    listSamples: () => [],
    firstSampleAtMs: () => null,
    firstSampleTimes: () => new Map(),
  } as unknown as QuotaStore;
  const collector = {
    refreshing: false,
    lastRefreshAtMs: null,
    nextRefreshAtMs: 0,
    issues: [],
    refresh: async () => {
      refreshes++;
    },
  };
  const handler = createHandler({ store, collector, keyFile, now: () => Date.UTC(2026, 9, 27) });
  const request = (path: string, auth = true, method = 'GET') =>
    handler(
      new Request('http://localhost' + path, {
        method,
        headers: auth ? { Authorization: 'Bearer synthetic-test-key' } : {},
      })
    );
  return { request, keyFile, store, reads: () => reads, refreshes: () => refreshes };
}
describe('quota history HTTP boundary', () => {
  test('fractional forecast depletion returns a dashboard instead of HTTP 503', async () => {
    const f = fixture();
    const now = Date.UTC(2026, 9, 27);
    f.store.listAccounts = () => [
      {
        id: 'fixture',
        provider: 'claude',
        name: 'fixture',
        email: null,
        disabled: false,
        retired: false,
        lastSeenAtMs: now,
        lastErrorAtMs: null,
      },
    ];
    f.store.listSamples = () =>
      [67, 14].map((remainingPercent, index) => ({
        accountId: 'fixture',
        window: 'five-hour',
        observedAtMs: now - (1 - index) * 600_000,
        remainingPercent,
        resetAtMs: now + 7_200_000,
        periodHours: 5,
      }));
    const response = f.request('/v1/pools?window=five-hour');
    expect(response.status).toBe(200);
    expect((await response.json()).pools[0].forecastState).toBe('ready');
  });
  test('authentication runs before disclosure and refresh work', () => {
    const f = fixture();
    expect(f.request('/v1/pools?reveal=true', false).status).toBe(401);
    expect(f.request('/v1/refresh', false, 'POST').status).toBe(401);
    expect(f.reads()).toBe(0);
    expect(f.refreshes()).toBe(0);
    expect(f.request('/healthz', false).status).toBe(200);
  });
  test('accepts the current key, fails closed on key loss and rotates without restarting', () => {
    const f = fixture();
    expect(f.request('/v1/pools').status).toBe(200);
    writeFileSync(f.keyFile, 'rotated-test-key');
    expect(f.request('/v1/pools').status).toBe(401);
    rmSync(f.keyFile);
    expect(f.request('/v1/pools').status).toBe(503);
  });
  test('bounded filters and no-store responses prevent unbounded reads and browser caching', async () => {
    const f = fixture();
    for (const invalid of [
      'lookback=999',
      'multiplier=-1',
      'offsetDays=15',
      'offsetDays=1.5',
      'window=monthly',
      'reveal=yes',
      'lookback=1&lookback=3',
    ]) {
      expect(f.request('/v1/pools?' + invalid).status).toBe(400);
    }
    expect(f.reads()).toBe(0);
    const response = f.request('/v1/pools?window=five-hour&reveal=false');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).pools).toHaveLength(2);
  });
  test('refresh is a separate authenticated POST, never a side effect of a GET', () => {
    const f = fixture();
    expect(f.request('/v1/refresh').status).toBe(404);
    expect(f.request('/v1/refresh', true, 'POST').status).toBe(202);
    expect(f.refreshes()).toBe(1);
  });
  test('filter defaults do not reveal account names', () => {
    expect(parseOptions(new URLSearchParams(), 123)).toEqual({
      nowMs: 123,
      window: 'weekly',
      lookbackHours: 3,
      multiplier: 1,
      offsetDays: 0,
      reveal: false,
    });
  });
});
