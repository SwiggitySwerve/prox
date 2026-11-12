import { describe, expect, test } from 'bun:test';
import type { SourceOwner } from '../src/services/api/sourceSession';
import {
  createModelAccessStore,
  selectSourceModelAccess,
  type ModelAccessSourceApi,
} from '../src/stores/useModelAccessStore';

const owner = (instanceId: string): SourceOwner => ({
  instanceId,
  sessionEpoch: 1,
  sourceGeneration: 1,
});
const ALPHA = owner('alpha');
const BETA = owner('beta');

function fakeHub(calls: string[], tag: string, fail = new Set<string>()) {
  let open = 0;
  const read = async <T>(what: string, value: T): Promise<T> => {
    calls.push(`${tag}:${what}`);
    open += 1;
    peak.max = Math.max(peak.max, open);
    await new Promise((resolve) => setTimeout(resolve, 1));
    open -= 1;
    if (fail.has(what)) throw new Error(`${what} failed`);
    return value;
  };
  const peak = { max: 0 };
  const api: ModelAccessSourceApi = {
    getProviderLists: () => read('lists', { claude: [] }),
    getAliases: () => read('aliases', {}),
    getCatalog: (provider) => read(`catalog:${provider}`, []),
    getAccountList: (name) => read(`list:${name}`, null),
    getAccountModels: (name) => read(`models:${name}`, []),
  };
  return { api, peak };
}

describe('model access: re-read everything already loaded', () => {
  test('re-reads each loaded slice of every source once, and nothing never loaded', async () => {
    const calls: string[] = [];
    const alpha = fakeHub(calls, 'alpha');
    const beta = fakeHub(calls, 'beta');
    const store = createModelAccessStore();
    store.getState().configure({
      api: (o) => (o.instanceId === 'alpha' ? alpha.api : beta.api),
      now: () => 0,
    });
    await store.getState().ensureConfig(ALPHA);
    await store.getState().ensureCatalog(ALPHA, 'claude');
    await store
      .getState()
      .ensureAccounts(ALPHA, [{ kind: 'file', name: 'a.json', disabled: false }] as never);
    await store.getState().ensureConfig(BETA);
    calls.length = 0;

    const failed = await store.getState().refreshLoaded();
    expect(failed).toEqual([]);
    expect(calls.sort()).toEqual(
      [
        'alpha:aliases',
        'alpha:catalog:claude',
        'alpha:list:a.json',
        'alpha:lists',
        'alpha:models:a.json',
        'beta:aliases',
        'beta:lists',
      ].sort()
    );
  });

  test('a read already in flight is joined, not sent twice', async () => {
    const calls: string[] = [];
    const alpha = fakeHub(calls, 'alpha');
    const store = createModelAccessStore();
    store.getState().configure({ api: () => alpha.api, now: () => 0 });
    await store.getState().ensureConfig(ALPHA);
    calls.length = 0;
    const page = store.getState().ensureConfig(ALPHA, { force: true });
    await store.getState().refreshLoaded();
    await page;
    expect(calls.sort()).toEqual(['alpha:aliases', 'alpha:lists']);
  });

  test('names the sources whose re-read failed and keeps their last data', async () => {
    const calls: string[] = [];
    const fail = new Set<string>();
    const alpha = fakeHub(calls, 'alpha', fail);
    const store = createModelAccessStore();
    store.getState().configure({ api: () => alpha.api, now: () => 0 });
    await store.getState().ensureConfig(ALPHA);
    fail.add('aliases');
    expect(await store.getState().refreshLoaded()).toEqual(['alpha']);
    const aliases = selectSourceModelAccess(store.getState(), ALPHA)?.aliases;
    expect(aliases?.status).toBe('error');
    expect(aliases && 'data' in aliases ? aliases.data : null).toEqual({});
  });

  test('per-account reads stay within a few at a time per source', async () => {
    const calls: string[] = [];
    const alpha = fakeHub(calls, 'alpha');
    const store = createModelAccessStore();
    store.getState().configure({ api: () => alpha.api, now: () => 0 });
    const accounts = Array.from({ length: 12 }, (_, index) => ({
      kind: 'file',
      name: `${index}.json`,
      disabled: false,
    }));
    await store.getState().ensureAccounts(ALPHA, accounts as never);
    alpha.peak.max = 0;
    await store.getState().refreshLoaded();
    expect(alpha.peak.max).toBeLessThanOrEqual(4);
  });
});
