import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaStore } from '../server/quota/store';
import { DAY_MS, type QuotaSample, type StoredAccount } from '../server/quota/types';

const NOW = 1_800_000_000_000;
const roots: string[] = [];
const stores: QuotaStore[] = [];
function open() {
  const root = mkdtempSync(join(tmpdir(), 'prox-store-'));
  roots.push(root);
  const path = join(root, 'private', 'quota.sqlite');
  const store = new QuotaStore(path);
  stores.push(store);
  return { store, path, directory: join(root, 'private') };
}
function account(
  id = 'claude:synthetic',
  provider: StoredAccount['provider'] = 'claude'
): StoredAccount {
  return {
    id,
    provider,
    name: 'synthetic.json',
    email: 'synthetic@example.test',
    disabled: false,
    retired: false,
    lastSeenAtMs: NOW,
    lastErrorAtMs: null,
  };
}
function sample(overrides: Partial<QuotaSample> = {}): QuotaSample {
  return {
    accountId: 'claude:synthetic',
    window: 'weekly',
    observedAtMs: NOW,
    remainingPercent: 73.5,
    resetAtMs: NOW + DAY_MS,
    periodHours: 168,
    ...overrides,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('QuotaStore', () => {
  test('persists normalized metadata and samples with WAL and private permissions', () => {
    const { store, path, directory } = open();
    expect(store.firstSampleAtMs()).toBeNull();
    store.recordInventory('claude', [account()], NOW);
    store.recordSamples([sample()]);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    const inspect = new Database(path, { readonly: true });
    expect(inspect.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    inspect.close();
    store.close();
    const reopened = new QuotaStore(path);
    stores.push(reopened);
    expect(reopened.listAccounts()).toEqual([account()]);
    expect(reopened.listSamples(NOW, NOW)).toEqual([sample()]);
    expect(reopened.firstSampleAtMs()).toBe(NOW);
  });

  test('reports the earliest sample of each account across windows', () => {
    const { store } = open();
    store.recordInventory('claude', [account(), account('claude:new')], NOW);
    expect(store.firstSampleTimes()).toEqual(new Map());
    store.recordSamples([
      sample({ observedAtMs: NOW + 5 }),
      sample({ window: 'five-hour', periodHours: 5, observedAtMs: NOW + 2 }),
      sample({ accountId: 'claude:new', observedAtMs: NOW + 9 }),
    ]);
    expect(store.firstSampleTimes()).toEqual(
      new Map([
        ['claude:synthetic', NOW + 2],
        ['claude:new', NOW + 9],
      ])
    );
  });

  test('duplicate observations are idempotent, range boundaries inclusive, and windows independent', () => {
    const { store } = open();
    store.recordInventory('claude', [account()], NOW);
    const observations = [
      sample({ observedAtMs: NOW - 1 }),
      sample(),
      sample({ window: 'five-hour', periodHours: 5 }),
      sample({ observedAtMs: NOW + 1 }),
    ];
    store.recordSamples(observations);
    store.recordSamples([sample({ remainingPercent: 1 })]);
    expect(store.listSamples(NOW - 1, NOW + 1)).toHaveLength(4);
    expect(store.listSamples(NOW, NOW, 'weekly')).toEqual([sample()]);
    expect(store.listSamples(NOW, NOW, 'five-hour')).toEqual([observations[2]]);
    expect(store.listSamples(NOW + 2, NOW + 3)).toEqual([]);
  });

  test('inventory retirement affects only its provider and reappearing identities are restored', () => {
    const { store } = open();
    store.recordInventory('claude', [account()], NOW);
    store.recordInventory('codex', [account('codex:synthetic', 'codex')], NOW);
    store.markAccountError('claude:synthetic', NOW);
    store.recordInventory('claude', [], NOW + 1);
    expect(store.listAccounts().map((row) => [row.provider, row.retired])).toEqual([
      ['claude', true],
      ['codex', false],
    ]);
    store.recordInventory(
      'claude',
      [{ ...account(), name: 'renamed.json', disabled: true }],
      NOW + 2
    );
    expect(store.listAccounts()[0]).toEqual({
      ...account(),
      name: 'renamed.json',
      disabled: true,
      lastSeenAtMs: NOW + 2,
      lastErrorAtMs: NOW,
    });
  });

  test('inventory transactions roll back retirement and partial writes on an identity collision', () => {
    const { store } = open();
    store.recordInventory('claude', [account()], NOW);
    store.recordInventory('codex', [account('codex:synthetic', 'codex')], NOW);
    const before = store.listAccounts();
    expect(() =>
      store.recordInventory('claude', [account('claude:new'), account('codex:synthetic')], NOW + 1)
    ).toThrow('Invalid quota identity');
    expect(store.listAccounts()).toEqual(before);
    expect(() => store.recordInventory('claude', [account('wrong', 'codex')], NOW)).toThrow();
    expect(() => store.recordInventory('claude', [account(), account()], NOW)).toThrow();
    expect(store.listAccounts()).toEqual(before);
  });

  test('sample failure rolls back successes and error clearing; successful retry clears errors', () => {
    const { store } = open();
    store.recordInventory('claude', [account()], NOW);
    store.markAccountError(account().id, NOW);
    expect(() =>
      store.recordSamples([sample(), sample({ observedAtMs: NOW + 1, remainingPercent: 101 })])
    ).toThrow();
    expect(store.listSamples(0, NOW + 1)).toEqual([]);
    expect(store.listAccounts()[0].lastErrorAtMs).toBe(NOW);
    expect(() => store.recordSamples([sample({ remainingPercent: NaN })])).toThrow();
    expect(() => store.recordSamples([sample({ accountId: 'unknown' })])).toThrow();
    store.recordSamples([sample()]);
    expect(store.listAccounts()[0].lastErrorAtMs).toBeNull();
    store.markAccountError(account().id, NOW + 1);
    store.recordSamples([sample()]);
    expect(store.listAccounts()[0].lastErrorAtMs).toBe(NOW + 1);
    store.recordSamples([sample({ observedAtMs: NOW + 2 })]);
    expect(store.listAccounts()[0].lastErrorAtMs).toBeNull();
  });

  test('prunes samples strictly older than 30 days without deleting account metadata', () => {
    const { store } = open();
    store.recordInventory('claude', [account()], NOW);
    store.recordSamples([
      sample({ observedAtMs: NOW - 30 * DAY_MS - 1 }),
      sample({ observedAtMs: NOW - 30 * DAY_MS }),
      sample(),
    ]);
    store.prune(NOW);
    expect(store.firstSampleAtMs()).toBe(NOW - 30 * DAY_MS);
    expect(store.listSamples(0, NOW)).toHaveLength(2);
    expect(store.listAccounts()).toHaveLength(1);
  });

  test('persists only the allowlisted metadata even when callers carry extra credential fields', () => {
    const { store, path } = open();
    const extra = {
      ...account(),
      access_token: 'DO_NOT_PERSIST_SYNTHETIC_TOKEN',
      auth_index: 'DO_NOT_PERSIST_RAW_INDEX',
      arbitrary: { authorization: 'secret' },
    };
    store.recordInventory('claude', [extra], NOW);
    expect(store.listAccounts()).toEqual([account()]);
    store.close();
    const contents = readFileSync(path).toString();
    expect(contents).not.toContain(extra.access_token);
    expect(contents).not.toContain(extra.auth_index);
  });
});
