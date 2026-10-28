import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/app';
import { QuotaCollector } from '../server/quota/collector';
import { buildDashboard, type DashboardOptions } from '../server/quota/domain';
import { legacyAccountId, LEGACY_SOURCE_MAPPING } from '../server/quota/identity';
import { QuotaStore } from '../server/quota/store';
import {
  DAY_MS,
  HOUR_MS,
  MANUAL_REFRESH_INTERVAL_MS,
  type StoredAccount,
} from '../server/quota/types';
import { validateSourceManifest } from '../src/domain/providerSources/manifest';
import type { PoolDashboard, PoolProviderId } from '../src/domain/quotaPool/types';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
} from '../src/utils/quota/constants';

const NOW = 1_800_000_000_000;
const SENTINEL = 'SYNTHETIC_PRIVATE_INVENTORY_VALUE';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'prox-quota-sources-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function open(path = ':memory:') {
  const store = new QuotaStore(path);
  cleanups.push(() => store.close());
  return store;
}
function credential(provider: string, index = 'same-index') {
  return {
    provider,
    type: provider,
    auth_index: index,
    name: 'same-file.json',
    email: 'same@example.test',
    disabled: false,
    account: SENTINEL,
    metadata: { access_token: SENTINEL },
  };
}
function usage(provider: PoolProviderId, used = 20) {
  return provider === 'claude'
    ? {
        seven_day: { utilization: used, resets_at: new Date(NOW + DAY_MS).toISOString() },
        five_hour: { utilization: used, resets_at: new Date(NOW + HOUR_MS).toISOString() },
      }
    : {
        rate_limit: {
          primary_window: {
            used_percent: used,
            limit_window_seconds: 604800,
            reset_at: (NOW + DAY_MS) / 1000,
          },
          secondary_window: {
            used_percent: used,
            limit_window_seconds: 18000,
            reset_at: (NOW + HOUR_MS) / 1000,
          },
        },
      };
}
const options: DashboardOptions = {
  nowMs: NOW,
  window: 'weekly',
  lookbackHours: 3,
  multiplier: 1,
  offsetDays: 0,
  reveal: false,
};
const state = {
  historyStartedAtMs: NOW,
  lastRefreshAtMs: NOW,
  nextRefreshAtMs: NOW,
  refreshing: false,
  issues: [],
};
type Call = { instanceId: string; url: URL; init: RequestInit; body?: Record<string, unknown> };

function fixture(ids = ['source-a', 'source-b', 'source-c']) {
  const root = temporary();
  const sources = ids.map((instanceId, index) => {
    const managementKeyFile = join(root, `${instanceId}.key`);
    writeFileSync(managementKeyFile, `synthetic-key-${instanceId}`);
    return {
      instanceId,
      label: `Label ${instanceId}`,
      publicBasePath: `/${instanceId}`,
      aliases: index === 0 ? ['', '/codex-alias'] : [],
      authScope: instanceId,
      upstreamOrigin: `http://${instanceId}.invalid`,
      managementKeyFile,
    };
  });
  const manifest = validateSourceManifest({
    schemaVersion: 1,
    defaultInstanceId: ids[0],
    history: {
      upstreamOrigin: 'http://history.invalid',
      managementKeyFile: sources[0].managementKeyFile,
    },
    sources,
  });
  const inventories = new Map<string, unknown>(
    ids.map((id, i) => [
      id,
      {
        files: [credential('claude'), ...(i === 2 ? [credential('codex'), credential('xai')] : [])],
      },
    ])
  );
  const failures = new Map<string, number>();
  const quotaFailures = new Set<string>();
  const calls: Call[] = [];
  let clock = NOW;
  let beforeResponse: ((call: Call) => Promise<void>) | undefined;
  const fetcher = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const instanceId = url.hostname.replace('.invalid', '');
      const call = {
        instanceId,
        url,
        init,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      await beforeResponse?.(call);
      if (!call.body) {
        if (failures.has(instanceId))
          return new Response(SENTINEL, { status: failures.get(instanceId)! });
        return Response.json(inventories.get(instanceId));
      }
      if (quotaFailures.has(instanceId)) return Response.json({ status_code: 429, body: SENTINEL });
      return Response.json({
        status_code: 200,
        body: usage(call.body.url === CLAUDE_USAGE_URL ? 'claude' : 'codex'),
      });
    },
    { preconnect: () => {} }
  ) satisfies typeof fetch;
  const store = open();
  const collector = new QuotaCollector(store, {
    sources: manifest.sources,
    revision: 'synthetic-revision',
    fetcher,
    now: () => clock,
  });
  cleanups.push(() => collector.stop());
  const dashboard = () =>
    buildDashboard(
      store.listAccounts(),
      store.listSamples(0, clock),
      { ...options, nowMs: clock },
      {
        ...state,
        issues: collector.issues,
        sources: collector.sources,
      }
    );
  return {
    sources,
    manifest,
    store,
    collector,
    calls,
    inventories,
    failures,
    quotaFailures,
    dashboard,
    fetcher,
    advance: () => {
      clock += MANUAL_REFRESH_INTERVAL_MS;
    },
    delay: (callback: (call: Call) => Promise<void>) => {
      beforeResponse = callback;
    },
  };
}

describe('enumerated quota sources', () => {
  test('enumerates aliases once, collects both supported kinds in mixed inventory, and retains every collision', async () => {
    const f = fixture();
    await f.collector.refresh();
    expect(
      f.calls
        .filter((call) => !call.body)
        .map((call) => call.instanceId)
        .sort()
    ).toEqual(['source-a', 'source-b', 'source-c']);
    expect(f.store.listAccounts()).toHaveLength(4);
    expect(new Set(f.store.listAccounts().map((account) => account.id)).size).toBe(4);
    expect(f.store.listSamples(NOW, NOW)).toHaveLength(8);
    for (const call of f.calls) {
      expect(new Headers(call.init.headers).get('authorization')).toBe(
        `Bearer synthetic-key-${call.instanceId}`
      );
      expect(call.init.redirect).toBe('error');
      if (call.body) {
        expect(call.url.pathname).toBe('/v8/management/requests/api-call');
        expect(call.body.method).toBe('GET');
        expect([CLAUDE_USAGE_URL, CLAUDE_PROFILE_URL, CODEX_USAGE_URL]).toContain(call.body.url);
        expect(call.body.authIndex).toBe('same-index');
        expect(Object.keys(call.body).sort()).toEqual(['authIndex', 'header', 'method', 'url']);
      } else expect(call.url.pathname).toBe('/v8/management/credentials');
    }
    expect(f.calls.filter((call) => call.body)).toHaveLength(7);
    expect(
      JSON.stringify([f.store.listAccounts(), f.dashboard(), f.collector.issues])
    ).not.toContain(SENTINEL);
    expect(JSON.stringify(f.dashboard())).not.toContain('synthetic-key');
    expect(
      f
        .dashboard()
        .pools.filter((pool) => pool.accountCount)
        .map((pool) => [pool.instanceId, pool.provider, pool.capacityPoints, pool.remainingPoints])
    ).toEqual([
      ['source-a', 'claude', 100, 80],
      ['source-b', 'claude', 100, 80],
      ['source-c', 'claude', 100, 80],
      ['source-c', 'codex', 100, 80],
    ]);
    expect(f.dashboard().combinations).toEqual([
      {
        provider: 'claude',
        reason: 'cross-source-combination-unverified',
        occurrenceCount: 3,
        capacityPoints: null,
        remainingPoints: null,
        burnPointsPerHour: null,
        drainPointsPerHour: null,
        firstEmptyAtMs: null,
        poolEmptyAtMs: null,
        recorded: [],
        projected: [],
      },
    ]);
  });

  test('complete empty retires only that source/provider; 401, failures and malformed inventories retire nothing', async () => {
    const f = fixture();
    await f.collector.refresh();
    const b = f.store.listAccounts().filter((account) => account.instanceId === 'source-b');
    f.inventories.set('source-a', { files: [] });
    for (const status of [401, 503]) {
      f.failures.set('source-b', status);
      f.advance();
      await f.collector.refresh();
      expect(f.store.listAccounts().filter((account) => account.instanceId === 'source-b')).toEqual(
        b
      );
      expect(
        f.store
          .listAccounts()
          .filter((account) => account.instanceId === 'source-a')
          .every((account) => account.retired)
      ).toBe(true);
      expect(
        f.store
          .listAccounts()
          .filter((account) => account.instanceId === 'source-c')
          .every((account) => !account.retired)
      ).toBe(true);
      expect(
        f.collector.issues.map((issue) => [issue.instanceId, issue.provider, issue.code])
      ).toEqual([
        ['source-b', 'claude', 'inventory-unavailable'],
        ['source-b', 'codex', 'inventory-unavailable'],
      ]);
    }
    f.failures.clear();
    for (const invalid of [
      {},
      { files: [], has_more: true },
      { files: [], total: 1 },
      { files: [credential('claude'), { ...credential('codex'), disabled: 'false' }] },
    ]) {
      f.inventories.set('source-b', invalid);
      f.advance();
      await f.collector.refresh();
      expect(f.store.listAccounts().filter((account) => account.instanceId === 'source-b')).toEqual(
        b
      );
      expect(
        f
          .dashboard()
          .pools.find((pool) => pool.instanceId === 'source-b' && pool.provider === 'claude')
          ?.remainingPoints
      ).toBeNull();
      expect(
        f
          .dashboard()
          .pools.find((pool) => pool.instanceId === 'source-c' && pool.provider === 'claude')
          ?.remainingPoints
      ).toBe(80);
    }
    f.inventories.set('source-c', { files: [credential('codex')] });
    f.advance();
    await f.collector.refresh();
    expect(
      f.store
        .listAccounts()
        .filter((account) => account.instanceId === 'source-c')
        .map((account) => [account.provider, account.retired])
    ).toEqual([
      ['claude', true],
      ['codex', false],
    ]);
  });

  test('key rotation/loss and quota failures are local to the owning source', async () => {
    const f = fixture();
    await f.collector.refresh();
    const before = f.store.listAccounts().find((account) => account.instanceId === 'source-b');
    rmSync(f.sources[1].managementKeyFile);
    writeFileSync(f.sources[0].managementKeyFile, 'synthetic-rotated');
    f.quotaFailures.add('source-a');
    f.calls.length = 0;
    f.advance();
    await f.collector.refresh();
    expect(f.calls.some((call) => call.instanceId === 'source-b')).toBe(false);
    expect(f.store.listAccounts().find((account) => account.instanceId === 'source-b')).toEqual(
      before
    );
    expect(
      f.calls
        .filter((call) => call.instanceId === 'source-a')
        .every(
          (call) =>
            new Headers(call.init.headers).get('authorization') === 'Bearer synthetic-rotated'
        )
    ).toBe(true);
    expect(f.collector.issues.filter((issue) => issue.instanceId === 'source-a')).toEqual([
      {
        instanceId: 'source-a',
        sourceLabel: 'Label source-a',
        provider: 'claude',
        code: 'quota-unavailable',
      },
    ]);
    expect(f.collector.issues.some((issue) => issue.instanceId === 'source-c')).toBe(false);
    expect(f.store.listSamples(NOW, NOW + MANUAL_REFRESH_INTERVAL_MS)).toHaveLength(12);
  });

  test('HTTP exposes source pools and first-inventory failures without leaking configuration', async () => {
    const f = fixture();
    f.failures.set('source-b', 401);
    await f.collector.refresh();
    const handler = createHandler({
      store: f.store,
      collector: f.collector,
      keyFile: f.sources[0].managementKeyFile,
      now: () => NOW,
    });
    const response = handler(
      new Request('http://history.invalid/v1/pools', {
        headers: { authorization: 'Bearer synthetic-key-source-a' },
      })
    );
    const data = (await response.json()) as PoolDashboard;
    expect(response.status).toBe(200);
    expect(
      data.pools
        .filter((pool) => pool.instanceId === 'source-b')
        .every((pool) => pool.forecastState === 'partial' && pool.remainingPoints === null)
    ).toBe(true);
    expect(
      data.pools.find((pool) => pool.instanceId === 'source-a' && pool.provider === 'claude')
        ?.remainingPoints
    ).toBe(80);
    expect(JSON.stringify(data)).not.toContain('.key');
    expect(JSON.stringify(data)).not.toContain('.invalid');
  });

  test('removed sources retain history but cannot present a complete current pool', async () => {
    const f = fixture();
    await f.collector.refresh();
    const result = buildDashboard(f.store.listAccounts(), f.store.listSamples(0, NOW), options, {
      ...state,
      sources: f.collector.sources!.filter((source) => source.instanceId !== 'source-b'),
    });
    const removed = result.pools.find(
      (pool) => pool.instanceId === 'source-b' && pool.provider === 'claude'
    )!;
    expect(removed.accountCount).toBe(1);
    expect(removed.forecastState).toBe('partial');
    expect(removed.remainingPoints).toBeNull();
    expect(removed.recorded[0].remainingPoints).toBe(80);
    expect(removed.projected).toEqual([]);
    expect(f.store.listAccounts().every((account) => !account.retired)).toBe(true);
  });

  test('collector pins a copied source revision and cannot be redirected by caller mutation', async () => {
    const f = fixture();
    const sources = f.sources.map((source) => ({ ...source }));
    const collector = new QuotaCollector(f.store, {
      sources,
      revision: 'pinned',
      fetcher: f.fetcher,
      now: () => NOW,
    });
    cleanups.push(() => collector.stop());
    sources[0].upstreamOrigin = 'http://wrong.invalid';
    sources[0].managementKeyFile = '/missing-synthetic-key';
    sources[0].instanceId = 'wrong';
    sources.length = 1;
    await collector.refresh();
    expect(collector.revision).toBe('pinned');
    expect(collector.sources?.map((source) => source.instanceId)).toEqual([
      'source-a',
      'source-b',
      'source-c',
    ]);
    expect(f.store.listAccounts()).toHaveLength(4);
    expect(f.calls.every((call) => call.instanceId !== 'wrong')).toBe(true);
  });

  test('an aborted inventory cannot retire or publish when a delayed fetch ignores abort', async () => {
    const f = fixture();
    await f.collector.refresh();
    const before = f.store.listAccounts();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.delay(async (call) => {
      if (!call.body) {
        entered();
        await gate;
      }
    });
    for (const id of f.inventories.keys()) f.inventories.set(id, { files: [] });
    f.advance();
    const pending = f.collector.refresh();
    await ready;
    f.collector.stop();
    release();
    await pending;
    expect(f.store.listAccounts()).toEqual(before);
    expect(f.store.listSamples(0, NOW + MANUAL_REFRESH_INTERVAL_MS)).toHaveLength(8);
  });
});

function legacyDatabase(path: string) {
  const db = new Database(path);
  // Actual pre-attribution schema: no ownership columns/tables.
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE quota_accounts (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
      disabled INTEGER NOT NULL, retired INTEGER NOT NULL, lastSeenAtMs INTEGER NOT NULL, lastErrorAtMs INTEGER
    );
    CREATE TABLE quota_samples (
      accountId TEXT NOT NULL REFERENCES quota_accounts(id), window TEXT NOT NULL,
      observedAtMs INTEGER NOT NULL, remainingPercent REAL, resetAtMs INTEGER, periodHours REAL,
      PRIMARY KEY (accountId, window, observedAtMs)
    );
  `);
  for (const provider of ['claude', 'codex'] as const) {
    const id = legacyAccountId(provider, 'same-index');
    db.query('INSERT INTO quota_accounts VALUES (?, ?, ?, ?, 0, 0, ?, NULL)').run(
      id,
      provider,
      'same-file.json',
      'same@example.test',
      NOW
    );
    for (const [at, remaining] of [
      [NOW - 40 * DAY_MS, 99],
      [NOW - 10 * 60_000, 90],
      [NOW - 5 * 60_000, 85],
      [NOW, 80],
    ]) {
      for (const window of ['weekly', 'five-hour']) {
        db.query('INSERT INTO quota_samples VALUES (?, ?, ?, ?, ?, ?)').run(
          id,
          window,
          at,
          remaining,
          NOW + DAY_MS,
          window === 'weekly' ? 168 : 5
        );
      }
    }
  }
  db.close();
}
function rawSnapshot(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      accounts: db.query('SELECT * FROM quota_accounts ORDER BY id').all(),
      samples: db
        .query('SELECT * FROM quota_samples ORDER BY accountId, window, observedAtMs')
        .all(),
      foreignKeys: db.query('PRAGMA foreign_key_check').all(),
    };
  } finally {
    db.close();
  }
}

describe('additive legacy quota attribution', () => {
  test('preserves every row/tuple and single-source results through migration, reopen and repeat', () => {
    const path = join(temporary(), 'quota.sqlite');
    legacyDatabase(path);
    const before = rawSnapshot(path);
    let store = open(path);
    const oldResult = buildDashboard(
      store.listAccounts(),
      store.listSamples(0, NOW),
      options,
      state
    );
    const ids = LEGACY_SOURCE_MAPPING.map((mapping) => mapping.instanceId);
    store.migrateLegacySources(LEGACY_SOURCE_MAPPING, ids);
    expect(rawSnapshot(path)).toEqual(before);
    expect(store.firstSampleAtMs()).toBe(NOW - 40 * DAY_MS);
    const result = buildDashboard(store.listAccounts(), store.listSamples(0, NOW), options, state);
    for (const oldPool of oldResult.pools) {
      const { instanceId, sourceLabel, ...pool } = result.pools.find(
        (pool) => pool.provider === oldPool.provider && pool.accountCount
      )!;
      expect(instanceId).toBe(`${oldPool.provider}-primary`);
      expect(sourceLabel).toBe(instanceId);
      expect(pool).toEqual(oldPool);
      expect(pool.forecastState).toBe('ready');
    }
    store.close();
    store = open(path);
    store.migrateLegacySources(LEGACY_SOURCE_MAPPING, ids);
    expect(rawSnapshot(path)).toEqual(before);
    expect(
      store.listAccounts().every((account) => account.instanceId === `${account.provider}-primary`)
    ).toBe(true);
    expect(store.accountIdFor('claude-primary', 'claude', 'same-index')).toBe(
      legacyAccountId('claude', 'same-index')
    );
    expect(store.accountIdFor('another-source', 'claude', 'same-index')).not.toBe(
      legacyAccountId('claude', 'same-index')
    );
  });

  test('rollback includes all ownership and ledger writes when a later mapping fails', () => {
    const path = join(temporary(), 'quota.sqlite');
    legacyDatabase(path);
    const store = open(path);
    const before = rawSnapshot(path);
    const db = new Database(path);
    db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON quota_account_sources
      WHEN NEW.instanceId = 'codex-primary' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    expect(() =>
      store.migrateLegacySources(LEGACY_SOURCE_MAPPING, ['claude-primary', 'codex-primary'])
    ).toThrow();
    expect(db.query('SELECT * FROM quota_account_sources').all()).toEqual([]);
    expect(db.query('SELECT * FROM quota_legacy_sources').all()).toEqual([]);
    expect(rawSnapshot(path)).toEqual(before);
    db.exec('DROP TRIGGER synthetic_failure');
    db.close();
    store.migrateLegacySources(LEGACY_SOURCE_MAPPING, ['claude-primary', 'codex-primary']);
    expect(rawSnapshot(path)).toEqual(before);
  });

  test('rejects ambiguous/unknown mappings and subsequent reassignment; unmapped history remains unresolved', () => {
    const path = join(temporary(), 'quota.sqlite');
    legacyDatabase(path);
    const store = open(path);
    const before = rawSnapshot(path);
    expect(() =>
      store.migrateLegacySources(
        [
          { provider: 'claude', instanceId: 'a' },
          { provider: 'claude', instanceId: 'b' },
        ],
        ['a', 'b']
      )
    ).toThrow('Ambiguous');
    expect(() =>
      store.migrateLegacySources([{ provider: 'claude', instanceId: 'unknown' }], ['a'])
    ).toThrow('unknown');
    store.migrateLegacySources([{ provider: 'claude', instanceId: 'a' }], ['a']);
    expect(() =>
      store.migrateLegacySources([{ provider: 'claude', instanceId: 'b' }], ['b'])
    ).toThrow('Conflicting');
    expect(rawSnapshot(path)).toEqual(before);
    const dashboard = buildDashboard(store.listAccounts(), store.listSamples(0, NOW), options, {
      ...state,
      sources: [{ instanceId: 'a', sourceLabel: 'A' }],
    });
    expect(dashboard.unresolvedHistoryAccountCount).toBe(1);
    expect(dashboard.pools.filter((pool) => pool.provider === 'codex')).toEqual([]);
    expect(
      store.listAccounts().find((account) => account.provider === 'codex')?.instanceId
    ).toBeUndefined();
  });

  test('attributed legacy IDs continue collecting on their owner and cannot be stolen or cross-retired', async () => {
    const path = join(temporary(), 'quota.sqlite');
    legacyDatabase(path);
    const store = open(path);
    const f = fixture(['claude-primary', 'other-claude']);
    store.migrateLegacySources(
      [{ provider: 'claude', instanceId: 'claude-primary' }],
      f.sources.map((source) => source.instanceId)
    );
    const legacy = store.listAccounts().find((account) => account.provider === 'claude')!;
    const collector = new QuotaCollector(store, {
      sources: f.manifest.sources,
      revision: 'fixture',
      fetcher: f.fetcher,
      now: () => NOW + MANUAL_REFRESH_INTERVAL_MS,
    });
    cleanups.push(() => collector.stop());
    await collector.refresh();
    const owned = store.listAccounts().filter((account) => account.provider === 'claude');
    expect(owned.map((account) => account.id)).toContain(legacy.id);
    expect(owned).toHaveLength(2);
    expect(
      store
        .listSamples(NOW + MANUAL_REFRESH_INTERVAL_MS, NOW + MANUAL_REFRESH_INTERVAL_MS)
        .map((sample) => sample.accountId)
    ).toContain(legacy.id);
    const before = store.listAccounts();
    expect(() =>
      store.recordInventory(
        'claude',
        [{ ...legacy, instanceId: 'other-claude' }],
        NOW,
        'other-claude'
      )
    ).toThrow('Invalid quota identity');
    expect(store.listAccounts()).toEqual(before);
    store.recordInventory('claude', [], NOW, 'claude-primary');
    expect(store.listAccounts().find((account) => account.id === legacy.id)?.retired).toBe(true);
    expect(
      store.listAccounts().find((account) => account.instanceId === 'other-claude')?.retired
    ).toBe(false);
    const sampleCount = store.listSamples(0, NOW + MANUAL_REFRESH_INTERVAL_MS).length;
    store.recordInventory('claude', [], NOW); // Legacy fixture seam cannot retire owned rows.
    expect(
      store.listAccounts().find((account) => account.instanceId === 'other-claude')?.retired
    ).toBe(false);
    expect(store.listSamples(0, NOW + MANUAL_REFRESH_INTERVAL_MS)).toHaveLength(sampleCount);
  });

  test('a source-qualified alias collision aborts mapping rather than merging two histories', () => {
    const path = join(temporary(), 'quota.sqlite');
    legacyDatabase(path);
    const store = open(path);
    const legacy = store.listAccounts().find((account) => account.provider === 'claude')!;
    const account: StoredAccount = {
      ...legacy,
      id: store.accountIdFor('a', 'claude', 'same-index'),
      instanceId: 'a',
    };
    store.recordInventory('claude', [account], NOW, 'a');
    const before = rawSnapshot(path);
    expect(() =>
      store.migrateLegacySources([{ provider: 'claude', instanceId: 'a' }], ['a'])
    ).toThrow();
    expect(rawSnapshot(path)).toEqual(before);
    expect(
      store.listAccounts().find((account) => account.id === legacy.id)?.instanceId
    ).toBeUndefined();
  });

  test('production wiring has no provider-keyed default origins and ships the authoritative manifest', () => {
    const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
    const collector = readFileSync(
      new URL('../server/quota/collector.ts', import.meta.url),
      'utf8'
    );
    const dockerfile = readFileSync(
      new URL('../deploy/Dockerfile.history', import.meta.url),
      'utf8'
    );
    expect(main).toContain('loadSourceManifest');
    expect(main).toContain('sources: manifest.sources');
    expect(main).toContain('manifest.history.managementKeyFile');
    expect(collector).not.toContain('DEFAULT_ORIGINS');
    expect(collector).not.toMatch(/127\.0\.0\.1:831[79]/);
    expect(dockerfile).toContain('COPY deploy/provider-sources.json');
  });
});
