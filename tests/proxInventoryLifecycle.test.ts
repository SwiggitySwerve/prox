import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInventory, inventoryVersion } from '../server/quota/inventory';
import { QuotaStore } from '../server/quota/store';
import {
  DAY_MS,
  RETIRED_ACCOUNT_NAME,
  RETIRED_GRACE_MS,
  type QuotaSample,
  type StoredAccount,
} from '../server/quota/types';
import type { PoolProviderId } from '../src/domain/quotaPool/types';

const NOW = 1_800_000_000_000;
const roots: string[] = [];
const stores: QuotaStore[] = [];
function open(now = () => NOW) {
  const root = mkdtempSync(join(tmpdir(), 'prox-lifecycle-'));
  roots.push(root);
  const path = join(root, 'quota.sqlite');
  const store = new QuotaStore(path, now);
  stores.push(store);
  return { store, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An account as the collector hands it over: `${instanceId}:${provider}:${digest}`. */
function account(
  digest: string,
  provider: PoolProviderId = 'claude',
  instanceId = `${provider}-primary`,
  overrides: Partial<StoredAccount> = {}
): StoredAccount {
  return {
    id: `${instanceId}:${provider}:${digest}`,
    instanceId,
    provider,
    name: `${digest}.json`,
    email: 'shared@example.test',
    disabled: false,
    retired: false,
    lastSeenAtMs: NOW,
    lastErrorAtMs: null,
    ...overrides,
  };
}
function sample(accountId: string, observedAtMs = NOW): QuotaSample {
  return {
    accountId,
    window: 'weekly',
    observedAtMs,
    remainingPercent: 50,
    resetAtMs: observedAtMs + DAY_MS,
    periodHours: 168,
  };
}
function rows(path: string, sql: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

describe('retiring an account', () => {
  test('scrubs email and name and stamps retiredAtMs in the same write', () => {
    const { store } = open();
    const kept = account('kept');
    const gone = account('gone');
    store.recordInventory('claude', [kept, gone], NOW, 'claude-primary');
    const change = store.recordInventory('claude', [kept], NOW + 5, 'claude-primary');
    expect(change).toEqual({ added: [], removed: [gone.id], purged: [] });
    const row = store.listAccounts().find((entry) => entry.id === gone.id)!;
    expect(row).toMatchObject({
      retired: true,
      retiredAtMs: NOW + 5,
      email: null,
      name: RETIRED_ACCOUNT_NAME,
    });
    expect(store.listAccounts().find((entry) => entry.id === kept.id)).toMatchObject({
      retired: false,
      email: 'shared@example.test',
      name: 'kept.json',
    });
    expect(store.isLive(gone.id)).toBe(false);
    expect(store.isLive(kept.id)).toBe(true);
  });

  test('leaves no email or name anywhere in the database file', () => {
    const { store, path } = open();
    const gone = account('gone', 'claude', 'claude-primary', {
      email: 'private.person@example.test',
      name: 'private.person@example.test.json',
    });
    store.recordInventory('claude', [gone], NOW, 'claude-primary');
    store.recordInventory('claude', [], NOW + 1, 'claude-primary');
    expect(JSON.stringify(rows(path, 'SELECT * FROM quota_accounts'))).not.toContain('private');
  });

  test('stamps retiredAtMs once: a later inventory that still lacks it does not extend the grace', () => {
    const { store } = open();
    const gone = account('gone');
    store.recordInventory('claude', [gone], NOW, 'claude-primary');
    store.recordInventory('claude', [], NOW + 10, 'claude-primary');
    store.recordInventory('claude', [], NOW + 99, 'claude-primary');
    expect(store.listAccounts()[0].retiredAtMs).toBe(NOW + 10);
  });

  test('re-adding restores email and name, clears retiredAtMs and keeps its samples', () => {
    const { store } = open();
    const gone = account('gone');
    store.recordInventory('claude', [gone], NOW, 'claude-primary');
    store.recordSamples([sample(gone.id)]);
    store.recordInventory('claude', [], NOW + 1, 'claude-primary');
    const change = store.recordInventory('claude', [gone], NOW + 2, 'claude-primary');
    expect(change.added).toEqual([gone.id]);
    const row = store.listAccounts()[0];
    expect(row).toMatchObject({ retired: false, email: gone.email, name: gone.name });
    expect(row.retiredAtMs).toBeUndefined();
    expect(store.listSamples(0, NOW + 5)).toHaveLength(1);
  });

  test('an account in another instance with the same email is untouched', () => {
    const { store } = open();
    const claude = account('one', 'claude');
    const codex = account('one', 'codex');
    store.recordInventory('claude', [claude], NOW, 'claude-primary');
    store.recordInventory('codex', [codex], NOW, 'codex-primary');
    store.recordInventory('claude', [], NOW + 1, 'claude-primary');
    const byId = new Map(store.listAccounts().map((entry) => [entry.id, entry]));
    expect(byId.get(claude.id)?.retired).toBe(true);
    expect(byId.get(codex.id)).toMatchObject({ retired: false, email: 'shared@example.test' });
  });
});

describe('purging deleted accounts', () => {
  function seed() {
    const fixture = open();
    const named = account('named');
    const other = account('other');
    const absent = account('absent');
    fixture.store.recordInventory('claude', [named, other, absent], NOW, 'claude-primary');
    for (const entry of [named, other, absent]) {
      fixture.store.recordSamples([sample(entry.id)]);
      fixture.store.recordPlan(entry.id, 'pro', NOW);
    }
    return { ...fixture, named, other, absent };
  }

  test('a named account that the fresh inventory confirms gone is purged now, children first', () => {
    const { store, path, named, other, absent } = seed();
    const change = store.recordInventory(
      'claude',
      [other],
      NOW + 1,
      'claude-primary',
      new Set([named.name])
    );
    expect(change).toEqual({ added: [], removed: [absent.id], purged: [named.id] });
    expect(store.listAccounts().map((entry) => entry.id)).toEqual([absent.id, other.id].sort());
    expect(
      store
        .listSamples(0, NOW + 5)
        .map((entry) => entry.accountId)
        .sort()
    ).toEqual([absent.id, other.id].sort());
    for (const table of ['quota_account_plans', 'quota_account_sources']) {
      expect(
        rows(path, `SELECT accountId FROM ${table}`)
          .map((row) => (row as { accountId: string }).accountId)
          .sort()
      ).toEqual([absent.id, other.id].sort());
    }
    expect(rows(path, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('a named account that is still in the inventory is not purged', () => {
    const { store, named, other } = seed();
    const change = store.recordInventory(
      'claude',
      [named, other],
      NOW + 1,
      'claude-primary',
      new Set([named.name])
    );
    expect(change.purged).toEqual([]);
    expect(store.isLive(named.id)).toBe(true);
  });

  test('absent accounts that were not named are only scrubbed, not purged', () => {
    const { store, absent } = seed();
    store.recordInventory('claude', [], NOW + 1, 'claude-primary', new Set(['nobody.json']));
    const row = store.listAccounts().find((entry) => entry.id === absent.id)!;
    expect(row).toMatchObject({ retired: true, name: RETIRED_ACCOUNT_NAME, email: null });
    expect(store.listSamples(0, NOW + 5)).toHaveLength(3);
  });

  test('a deleted name matches only its own instance and provider', () => {
    const { store } = open();
    const claude = account('same', 'claude');
    const codex = account('same', 'codex');
    store.recordInventory('claude', [claude], NOW, 'claude-primary');
    store.recordInventory('codex', [codex], NOW, 'codex-primary');
    store.recordInventory('claude', [], NOW + 1, 'claude-primary', new Set([claude.name]));
    expect(store.listAccounts().map((entry) => entry.id)).toEqual([codex.id]);
    expect(store.isLive(codex.id)).toBe(true);
  });

  test('purgeRetired removes only accounts that are already retired', () => {
    const { store, path } = open();
    const live = account('live');
    const gone = account('gone');
    store.recordInventory('claude', [live, gone], NOW, 'claude-primary');
    for (const entry of [live, gone]) store.recordSamples([sample(entry.id)]);
    store.recordInventory('claude', [live], NOW + 1, 'claude-primary');
    expect(store.purgeRetired([live.id, gone.id, 'unknown'])).toEqual([gone.id]);
    expect(store.listAccounts().map((entry) => entry.id)).toEqual([live.id]);
    expect(store.listSamples(0, NOW + 5).map((entry) => entry.accountId)).toEqual([live.id]);
    expect(rows(path, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('prune purges accounts retired for the whole 24 h grace and nothing sooner', () => {
    const { store, path } = open();
    const early = account('early');
    const late = account('late');
    const live = account('live');
    store.recordInventory('claude', [early, late, live], NOW, 'claude-primary');
    for (const entry of [early, late, live]) store.recordSamples([sample(entry.id)]);
    store.recordInventory('claude', [late, live], NOW + 1000, 'claude-primary');
    store.recordInventory('claude', [live], NOW + 2000, 'claude-primary');
    expect(store.prune(NOW + 1000 + RETIRED_GRACE_MS - 1)).toEqual([]);
    expect(store.prune(NOW + 1000 + RETIRED_GRACE_MS)).toEqual([early.id]);
    expect(store.prune(NOW + 2000 + RETIRED_GRACE_MS)).toEqual([late.id]);
    expect(store.listAccounts().map((entry) => entry.id)).toEqual([live.id]);
    expect(store.listSamples(0, NOW + 5).map((entry) => entry.accountId)).toEqual([live.id]);
    expect(rows(path, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('accounts retired before the lifecycle existed', () => {
  test('are backfilled on open: scrubbed now, purged after the grace period', () => {
    const root = mkdtempSync(join(tmpdir(), 'prox-lifecycle-legacy-'));
    roots.push(root);
    const path = join(root, 'quota.sqlite');
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE quota_accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
        disabled INTEGER NOT NULL, retired INTEGER NOT NULL, lastSeenAtMs INTEGER NOT NULL,
        lastErrorAtMs INTEGER
      );
      INSERT INTO quota_accounts VALUES
        ('claude:old', 'claude', 'old.json', 'old@example.test', 0, 1, 1, NULL),
        ('claude:live', 'claude', 'live.json', 'live@example.test', 0, 0, 1, NULL);
    `);
    db.close();
    const store = new QuotaStore(path, () => NOW);
    stores.push(store);
    const byId = new Map(store.listAccounts().map((entry) => [entry.id, entry]));
    expect(byId.get('claude:old')).toMatchObject({
      retired: true,
      email: null,
      name: RETIRED_ACCOUNT_NAME,
      retiredAtMs: NOW,
    });
    expect(byId.get('claude:live')).toMatchObject({ email: 'live@example.test', retired: false });
    expect(store.prune(NOW + RETIRED_GRACE_MS - 1)).toEqual([]);
    expect(store.prune(NOW + RETIRED_GRACE_MS)).toEqual(['claude:old']);
  });

  test('opening twice does not move the backfilled timestamp or fail the guarded ALTER', () => {
    const { store, path } = open();
    store.recordInventory('claude', [account('gone')], NOW, 'claude-primary');
    store.recordInventory('claude', [], NOW + 7, 'claude-primary');
    store.close();
    const reopened = new QuotaStore(path, () => NOW + 12345);
    stores.push(reopened);
    expect(reopened.listAccounts()[0].retiredAtMs).toBe(NOW + 7);
  });
});

describe('inventory version', () => {
  const accounts = () => [account('a', 'claude'), account('b', 'claude'), account('c', 'codex')];

  test('is stable across order, renames, email changes and unrelated field changes', () => {
    const base = inventoryVersion(accounts());
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(inventoryVersion([...accounts()].reverse())).toBe(base);
    expect(
      inventoryVersion(
        accounts().map((entry) => ({
          ...entry,
          name: 'renamed.json',
          email: 'new@example.test',
          lastSeenAtMs: NOW + 1,
          lastErrorAtMs: NOW,
          plan: 'max',
        }))
      )
    ).toBe(base);
  });

  test('changes when an account is added, removed or toggled disabled', () => {
    const base = inventoryVersion(accounts());
    const versions = new Set([
      base,
      inventoryVersion([...accounts(), account('d', 'codex')]),
      inventoryVersion(accounts().slice(1)),
      inventoryVersion(
        accounts().map((entry, index) => (index ? entry : { ...entry, disabled: true }))
      ),
    ]);
    expect(versions.size).toBe(4);
  });

  test('ignores retired accounts and accounts no source has claimed', () => {
    const base = inventoryVersion(accounts());
    const retired = account('r', 'claude', 'claude-primary', { retired: true });
    const unattributed: StoredAccount = { ...account('u'), instanceId: undefined };
    expect(inventoryVersion([...accounts(), retired, unattributed])).toBe(base);
  });

  test('tells two instances with the same digest apart', () => {
    expect(inventoryVersion([account('a', 'claude', 'one')])).not.toBe(
      inventoryVersion([account('a', 'claude', 'two')])
    );
  });

  test('the read model carries ids and flags only, never a name or an email', () => {
    const view = buildInventory(
      [
        account('a', 'claude', 'claude-primary', {
          email: 'secret@example.test',
          name: 'secret.json',
        }),
      ],
      [
        { instanceId: 'claude-primary', provider: 'claude', state: 'ok' },
        { instanceId: 'claude-primary', provider: 'codex', state: 'unavailable' },
      ],
      NOW
    );
    const text = JSON.stringify(view);
    expect(text).not.toContain('secret');
    expect(view.sources).toEqual([
      {
        instanceId: 'claude-primary',
        provider: 'claude',
        state: 'ok',
        accounts: [
          {
            accountId: 'claude-primary:claude:a',
            sourceAccountId: 'claude-primary:claude:a',
            disabled: false,
          },
        ],
      },
      { instanceId: 'claude-primary', provider: 'codex', state: 'unavailable', accounts: [] },
    ]);
    expect(view.syncedAtMs).toBe(NOW);
  });
});
