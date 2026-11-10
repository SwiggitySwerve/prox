import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountRefs,
  buildInventory,
  configLoadError,
  deriveInventoryLoad,
  type AccountRef,
} from '../src/features/authFiles/modelAccess/inventory';
import { buildMatrix } from '../src/features/authFiles/modelAccess/resolve';
import type { SourceOwner } from '../src/services/api/sourceSession';
import {
  createModelAccessStore,
  MODEL_ACCESS_MAX_AGE_MS,
  selectSourceModelAccess,
  type ModelAccessSourceApi,
} from '../src/stores/useModelAccessStore';
import type { AuthFileItem } from '../src/types';

const owner = (sessionEpoch: number, instanceId = 'alpha'): SourceOwner => ({
  instanceId,
  sessionEpoch,
  sourceGeneration: 1,
});
const OWNER = owner(1);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** An in-memory hub with a call log; every read can be replaced per test. */
function hub() {
  const calls: string[] = [];
  const state = {
    providerLists: { claude: ['claude-3-*'] } as Record<string, string[]>,
    aliases: { claude: [{ name: 'claude-opus-4-5', alias: 'opus' }] },
    catalog: ['claude-opus-4-5', 'claude-3-7-sonnet'],
    lists: { 'a.json': null, 'b.json': ['claude-opus-4-5'] } as Record<string, string[] | null>,
    models: {
      'a.json': ['claude-opus-4-5'],
      'b.json': ['claude-3-7-sonnet'],
      'key:1': ['claude-opus-4-5'],
    } as Record<string, string[]>,
  };
  const api: ModelAccessSourceApi = {
    getProviderLists: async () => (calls.push('lists'), state.providerLists),
    getAliases: async () => (calls.push('aliases'), state.aliases),
    getCatalog: async (provider) => (
      calls.push(`catalog:${provider}`),
      state.catalog.map((id) => ({ id }))
    ),
    getAccountList: async (name) => (calls.push(`list:${name}`), state.lists[name] ?? null),
    getAccountModels: async (name) => (
      calls.push(`models:${name}`),
      (state.models[name] ?? []).map((id) => ({ id }))
    ),
  };
  let now = 1_000;
  const store = createModelAccessStore();
  store.getState().configure({ api: () => api, now: () => now });
  return { store, api, calls, state, advance: (ms: number) => (now += ms) };
}

const REFS: AccountRef[] = [
  { name: 'a.json', label: 'a', disabled: false, kind: 'file' },
  { name: 'b.json', label: 'b', disabled: false, kind: 'file' },
  { name: 'key:1', label: 'key', disabled: false, kind: 'runtime' },
];
const access = (h: ReturnType<typeof hub>, o = OWNER) =>
  selectSourceModelAccess(h.store.getState(), o);

describe('one model-access store for every screen', () => {
  test('ensureProvider reads each slice once; a second screen asking again reads nothing', async () => {
    const h = hub();
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    expect(h.calls.sort()).toEqual(
      [
        'aliases',
        'catalog:claude',
        'list:a.json',
        'list:b.json',
        'lists',
        'models:a.json',
        'models:b.json',
        'models:key:1',
      ].sort()
    );
    h.calls.length = 0;
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    await h.store.getState().ensureConfig(OWNER);
    expect(h.calls).toEqual([]);
  });

  test('a runtime credential has no file: its own list is never read', async () => {
    const h = hub();
    await h.store.getState().ensureAccounts(OWNER, [REFS[2]]);
    expect(h.calls).toEqual(['models:key:1']);
  });

  test('after a write only the named models are re-read, a few at a time', async () => {
    const h = hub();
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    h.calls.length = 0;
    let running = 0;
    let peak = 0;
    const names = Array.from({ length: 10 }, (_, index) => `n${index}.json`);
    h.api.getAccountModels = async (name) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      h.calls.push(`models:${name}`);
      return [];
    };
    await h.store.getState().ensureAccountsModels(OWNER, ['a.json', ...names], { force: true });
    expect(h.calls.sort()).toEqual(['a.json', ...names].map((name) => `models:${name}`).sort());
    expect(peak).toBeLessThanOrEqual(4);
  });

  test('concurrent asks share one request', async () => {
    const h = hub();
    await Promise.all([
      h.store.getState().ensureConfig(OWNER),
      h.store.getState().ensureConfig(OWNER),
      h.store.getState().ensureConfig(OWNER),
    ]);
    expect(h.calls.sort()).toEqual(['aliases', 'lists']);
  });

  test('data older than the max age is re-read; force always re-reads', async () => {
    const h = hub();
    await h.store.getState().ensureConfig(OWNER);
    h.calls.length = 0;
    h.advance(MODEL_ACCESS_MAX_AGE_MS + 1);
    await h.store.getState().ensureConfig(OWNER);
    expect(h.calls.sort()).toEqual(['aliases', 'lists']);
    h.calls.length = 0;
    await h.store.getState().ensureConfig(OWNER, { force: true });
    expect(h.calls.sort()).toEqual(['aliases', 'lists']);
  });

  test('a forced re-read supersedes a slower earlier response', async () => {
    const h = hub();
    const slow = deferred<Record<string, string[]>>();
    h.api.getProviderLists = () => slow.promise;
    const first = h.store.getState().ensureConfig(OWNER);
    h.api.getProviderLists = async () => ({ claude: ['new'] });
    await h.store.getState().ensureConfig(OWNER, { force: true });
    slow.resolve({ claude: ['old'] });
    await first;
    expect(access(h)!.providerLists).toMatchObject({ status: 'ready', data: { claude: ['new'] } });
  });

  test('a failed re-read keeps the last good data and says so', async () => {
    const h = hub();
    await h.store.getState().ensureConfig(OWNER);
    h.api.getProviderLists = async () => {
      throw new Error('hub unreachable');
    };
    await h.store.getState().ensureConfig(OWNER, { force: true });
    expect(access(h)!.providerLists).toMatchObject({
      status: 'error',
      message: 'hub unreachable',
      data: { claude: ['claude-3-*'] },
    });
    expect(configLoadError(access(h)!.providerLists)).toBe('load');
  });

  test('a missing route (404) is unsupported, not a generic failure', async () => {
    const h = hub();
    h.api.getAliases = async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    };
    await h.store.getState().ensureConfig(OWNER);
    expect(configLoadError(access(h)!.aliases)).toBe('unsupported');
    expect(configLoadError(access(h)!.providerLists)).toBeNull();
  });

  test('a new session for the same source never shows the previous owner data', async () => {
    const h = hub();
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    const next = owner(2);
    expect(access(h, next)).toBeUndefined();
    await h.store.getState().ensureConfig(next);
    expect(access(h, OWNER)).toBeUndefined();
    expect(access(h, next)!.accountLists).toEqual({});
  });

  test('a response for a replaced session is dropped', async () => {
    const h = hub();
    const slow = deferred<Record<string, string[]>>();
    h.api.getProviderLists = () => slow.promise;
    const first = h.store.getState().ensureConfig(OWNER);
    const next = owner(2);
    h.api.getProviderLists = async () => ({ claude: ['next-owner'] });
    await h.store.getState().ensureConfig(next);
    slow.resolve({ claude: ['previous-owner'] });
    await first;
    expect(access(h, next)!.providerLists).toMatchObject({ data: { claude: ['next-owner'] } });
  });

  test('invalidating an account forgets its slices and re-reads them on the next ask', async () => {
    const h = hub();
    await h.store.getState().ensureAccounts(OWNER, REFS);
    h.store.getState().invalidateAccounts(OWNER, ['b.json']);
    expect(Object.keys(access(h)!.accountLists)).toEqual(['a.json']);
    h.calls.length = 0;
    await h.store.getState().ensureAccounts(OWNER, REFS);
    expect(h.calls.sort()).toEqual(['list:b.json', 'models:b.json']);
  });

  test('a response in flight for an invalidated account is ignored', async () => {
    const h = hub();
    const slow = deferred<string[] | null>();
    h.api.getAccountList = () => slow.promise;
    const first = h.store.getState().ensureAccounts(OWNER, [REFS[0]]);
    h.store.getState().invalidateAccounts(OWNER, ['a.json']);
    slow.resolve(['stale']);
    await first;
    expect(access(h)!.accountLists['a.json']).toBeUndefined();
  });

  test('a disabled account is not asked for models, and re-enabling re-reads them', async () => {
    const h = hub();
    await h.store.getState().ensureAccounts(OWNER, [REFS[0]]);
    h.calls.length = 0;
    await h.store.getState().ensureAccounts(OWNER, [{ ...REFS[0], disabled: true }]);
    expect(h.calls).toEqual([]);
    expect(access(h)!.accountModels['a.json']).toBeUndefined();
    await h.store.getState().ensureAccounts(OWNER, [REFS[0]]);
    expect(h.calls).toEqual(['models:a.json']);
  });

  test('reset drops everything, and an unconfigured store reads nothing', async () => {
    const h = hub();
    await h.store.getState().ensureConfig(OWNER);
    h.store.getState().reset();
    expect(h.store.getState().sources).toEqual({});
    const bare = createModelAccessStore();
    await bare.getState().ensureConfig(OWNER);
    expect(bare.getState().sources).toEqual({});
  });
});

describe('what screens derive from the store', () => {
  test('the inventory and the matrix come straight from the slices', async () => {
    const h = hub();
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    const inventory = buildInventory(access(h)!, 'claude', REFS);
    expect(inventory.providerList).toEqual(['claude-3-*']);
    expect(inventory.aliases).toEqual([{ name: 'claude-opus-4-5', alias: 'opus' }]);
    const rows = new Map(buildMatrix(inventory).map((row) => [row.model, row]));
    // a.json follows the provider list; b.json's own list replaces it; the runtime credential
    // (no file) follows the provider list too.
    expect(rows.get('claude-opus-4-5')!.cells).toEqual({
      'a.json': { kind: 'served', via: 'provider' },
      'b.json': { kind: 'excluded-own', rule: 'claude-opus-4-5', drift: false },
      'key:1': { kind: 'served', via: 'provider' },
    });
    expect(rows.get('claude-3-7-sonnet')!.cells['key:1']).toEqual({
      kind: 'wildcard',
      rule: 'claude-3-*',
      list: 'provider',
      drift: false,
    });
    expect(rows.get('claude-opus-4-5')!.servedBy).toEqual(['a.json', 'key:1']);
  });

  test('the derived load state names the combination of slices', async () => {
    const h = hub();
    const derive = (accounts: AccountRef[] | undefined, credentialError?: string) =>
      deriveInventoryLoad({ access: access(h), provider: 'claude', accounts, credentialError });
    expect(deriveInventoryLoad({ access: undefined, provider: '', accounts: REFS }).status).toBe(
      'idle'
    );
    expect(derive(undefined).status).toBe('loading');
    expect(derive(undefined, 'hub unreachable')).toMatchObject({
      status: 'error',
      message: 'hub unreachable',
      data: null,
    });
    expect(derive(REFS).status).toBe('loading');
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    expect(derive(REFS).status).toBe('ready');
    // An account whose own read failed is unknown, not a failed screen.
    h.api.getAccountList = async () => {
      throw new Error('download failed');
    };
    h.store.getState().invalidateAccounts(OWNER, ['a.json']);
    await h.store.getState().ensureAccounts(OWNER, REFS);
    const partial = derive(REFS);
    expect(partial.status).toBe('ready');
    expect(partial.status === 'ready' && partial.data.accounts[0].ownList).toEqual({
      status: 'unknown',
      message: 'download failed',
    });
  });

  test('a provider-list failure with nothing to show is an error for the screen', async () => {
    const h = hub();
    h.api.getProviderLists = async () => {
      throw new Error('hub unreachable');
    };
    await h.store.getState().ensureProvider(OWNER, 'claude', REFS);
    expect(
      deriveInventoryLoad({ access: access(h), provider: 'claude', accounts: REFS })
    ).toMatchObject({ status: 'error', message: 'hub unreachable', data: null });
  });

  test('accounts: credential files first, then runtime credentials, one provider only', () => {
    const files: AuthFileItem[] = [
      { name: 'key:1', type: 'claude', runtime_only: true },
      { name: 'b.json', type: 'claude', email: 'b@example.invalid', disabled: true },
      { name: 'c.json', type: 'codex' },
      { name: 'a.json', type: 'claude' },
    ];
    expect(accountRefs(files, 'claude')).toEqual([
      { name: 'b.json', label: 'b@example.invalid', disabled: true, kind: 'file' },
      { name: 'a.json', label: 'a', disabled: false, kind: 'file' },
      { name: 'key:1', label: 'key:1', disabled: false, kind: 'runtime' },
    ]);
  });
});

describe('every screen reads model access through the one store', () => {
  const root = join(import.meta.dir, '..');
  const sources = (directory: string): string[] =>
    readdirSync(join(root, directory)).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(join(root, path)).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  // The reads behind the store's five kinds of slice.
  const RAW_READS =
    /\.\s*(getOauthExcludedModels|getOauthModelAlias|getModelsForAuthFile|getModelDefinitions)\s*\(/;

  test('only the store runtime (and the API module itself) calls the raw reads', () => {
    const callers = sources('src').filter((path) =>
      RAW_READS.test(readFileSync(join(root, path), 'utf8'))
    );
    expect(callers.sort()).toEqual([
      'src/features/authFiles/modelAccessRuntime.ts',
      'src/services/api/authFiles.ts',
    ]);
  });

  test('an account list is read directly only to check staleness right before a write', () => {
    const callers = sources('src').filter((path) =>
      /\.\s*readAccountExcludedModels\s*\(/.test(readFileSync(join(root, path), 'utf8'))
    );
    expect(callers.sort()).toEqual([
      // the Models edit session's stale check
      'src/features/authFiles/hooks/useModelAccessInventory.ts',
      'src/features/authFiles/modelAccessRuntime.ts',
    ]);
  });

  const SCREENS = [
    'src/features/authFiles/hooks/useModelAccessInventory.ts',
    'src/features/authFiles/hooks/useAuthFilesOauth.tsx',
    'src/features/authFiles/hooks/useAuthFilesModels.ts',
    'src/features/authFiles/components/AuthFileModelsModal.tsx',
    'src/features/authFiles/components/AuthFileExcludedModelsField.tsx',
    'src/pages/AuthFilesOAuthModelAliasEditPage.tsx',
  ];
  for (const path of SCREENS) {
    test(`${path} uses the shared store`, () => {
      const text = readFileSync(join(root, path), 'utf8');
      expect(text).toMatch(/modelAccess\(\)|useSourceModelAccess\(|useModelAccessStore/);
    });
  }
});
