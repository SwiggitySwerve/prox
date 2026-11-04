import { afterEach, describe, expect, test } from 'bun:test';
import type { PoolDashboard } from '../src/domain/quotaPool/types';
import { createPoolResource, type PoolInventoryLink } from '../src/features/quotaPool/poolResource';
import type { PoolQuery } from '../src/services/api/quotaPool';
import type { SourceOwner } from '../src/services/api/sourceSession';
import {
  createCredentialInventoryStore,
  type InventoryRuntime,
} from '../src/stores/useCredentialInventoryStore';

const query: PoolQuery = {
  window: 'weekly',
  lookback: 3,
  multiplier: 1,
  offsetDays: 0,
  reveal: false,
};
const owner: SourceOwner = { instanceId: 'codex-primary', sessionEpoch: 0, sourceGeneration: 1 };
const dashboard = (accounts: string[], version: string, refreshing = false) =>
  ({
    refreshing,
    inventoryVersion: version,
    pools: [{ accounts: accounts.map((id) => ({ id })) }],
  }) as unknown as PoolDashboard;
const accountsOf = (data: PoolDashboard | null) =>
  (data?.pools[0] as unknown as { accounts: { id: string }[] } | undefined)?.accounts.map(
    (account) => account.id
  );
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** A real store whose "server" is whatever `world` currently says. */
function setup() {
  const world = { version: 'v1', accounts: ['a', 'b'] };
  const store = createCredentialInventoryStore();
  const runtime: InventoryRuntime = {
    sources: () => [{ instanceId: owner.instanceId, owner, list: async () => [] }],
    readVersion: async () => ({ status: 'changed', version: world.version }),
    sync: async () => {},
    visible: () => true,
    onVisibilityChange: () => () => {},
    every: () => () => {},
    channel: null,
  };
  store.getState().configure(runtime);
  const noted: string[] = [];
  const link: PoolInventoryLink = {
    attach: (key, read) => store.getState().registerPool(key, read),
    committed: (key) => {
      const { pool } = store.getState();
      return pool?.key === key ? { data: pool.data, revision: pool.revision } : null;
    },
    subscribe: (listener) => store.subscribe(listener),
    noteVersion: (version) => {
      noted.push(version);
      store.getState().noteVersion(version);
    },
  };
  const reads = {
    held: undefined as undefined | Promise<void>,
    count: 0,
    signals: [] as AbortSignal[],
  };
  const api = {
    get: async (_: PoolQuery, signal: AbortSignal) => {
      reads.count++;
      reads.signals.push(signal);
      const snapshot = dashboard(world.accounts, world.version);
      await reads.held;
      return snapshot;
    },
    refresh: async () => ({ refreshing: false, nextRefreshAtMs: 0, lastRefreshAtMs: null }),
    refreshAccount: async () => ({ refreshed: false }),
  };
  const resource = createPoolResource(api, query, () => true, link);
  disposers.push(resource.subscribe(() => {}));
  return { world, store, resource, reads, noted };
}

describe('pool resource joined to the credential inventory', () => {
  test('registers its query with the inventory while displayed and discards the pool after', async () => {
    const f = setup();
    await flush();
    await f.store.getState().refresh();
    expect(f.store.getState().pool?.key).toBe(JSON.stringify(query));
    disposers.pop()!();
    expect(f.store.getState().pool).toBeNull();
    await f.store.getState().refresh();
    expect(f.store.getState().pool).toBeNull(); // nothing displays it, so nothing reads it
  });

  test('a pool committed with the files replaces what is shown, in the same step', async () => {
    const f = setup();
    await flush();
    expect(accountsOf(f.resource.getSnapshot().data)).toEqual(['a', 'b']);
    f.world.accounts = ['a'];
    f.world.version = 'v2';
    await f.store.getState().refresh();
    expect(accountsOf(f.resource.getSnapshot().data)).toEqual(['a']);
    expect(f.resource.getSnapshot().data?.inventoryVersion).toBe('v2');
  });

  test('a read already in flight cannot bring back an account a commit removed', async () => {
    const f = setup();
    await flush();
    const slow = deferred<void>();
    f.reads.held = slow.promise;
    void f.resource.reload(); // requested while the account still existed
    await flush();
    const inFlight = f.reads.signals.at(-1)!;
    f.reads.held = undefined;
    f.world.accounts = ['a'];
    f.world.version = 'v2';
    // Watch every snapshot the screen would render from the commit on, not just the last one:
    // a stale answer is also corrected by the next refresh, but must never flash.
    const shown: (string[] | undefined)[] = [];
    disposers.push(
      f.resource.subscribe(() => shown.push(accountsOf(f.resource.getSnapshot().data)))
    );
    await f.store.getState().refresh();
    expect(inFlight.aborted).toBe(true);
    slow.resolve();
    await flush();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((accounts) => !accounts?.includes('b'))).toBe(true);
    expect(accountsOf(f.resource.getSnapshot().data)).toEqual(['a']);
  });

  test('an ordinary read reports its inventory version so a drifted inventory is refreshed', async () => {
    const f = setup();
    await f.store.getState().refresh(); // the store now holds v1
    f.world.version = 'v2';
    f.world.accounts = ['a'];
    await f.resource.reload(); // an outside change reaches the pool poll first
    await flush();
    expect(f.noted).toContain('v2');
    expect(f.store.getState().version).toBe('v2');
    expect(accountsOf(f.resource.getSnapshot().data)).toEqual(['a']);
  });

  test('a commit that kept the old pool does not republish it over a newer read', async () => {
    const f = setup();
    await f.store.getState().refresh();
    const adopted = f.resource.getSnapshot().data;
    f.world.accounts = ['a'];
    await f.resource.reload(); // a fresher pool than the store's
    const fresher = f.resource.getSnapshot().data;
    expect(fresher).not.toBe(adopted);
    await f.store.getState().refresh(); // commits a new pool (revision moves)
    expect(f.resource.getSnapshot().data).not.toBe(fresher);
  });

  test('the resource still works with no inventory at all', async () => {
    const resource = createPoolResource(
      {
        get: async () => dashboard(['a'], 'v1'),
        refresh: async () => ({ refreshing: false, nextRefreshAtMs: 0, lastRefreshAtMs: null }),
        refreshAccount: async () => ({ refreshed: false }),
      },
      query,
      () => true
    );
    disposers.push(resource.subscribe(() => {}));
    await flush();
    expect(accountsOf(resource.getSnapshot().data)).toEqual(['a']);
  });
});
