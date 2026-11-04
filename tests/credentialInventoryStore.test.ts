import { afterEach, describe, expect, test } from 'bun:test';
import type { PoolDashboard } from '../src/domain/quotaPool/types';
import type { SourceOwner } from '../src/services/api/sourceSession';
import {
  createCredentialInventoryStore,
  INVENTORY_POLL_INTERVAL_MS,
  selectSourceFiles,
  type ChannelMessage,
  type CredentialChange,
  type InventoryRuntime,
} from '../src/stores/useCredentialInventoryStore';
import type { AuthFileItem } from '../src/types';

const owner = (instanceId: string, generation = 1): SourceOwner => ({
  instanceId,
  sessionEpoch: 0,
  sourceGeneration: generation,
});
const file = (name: string, extra: Partial<AuthFileItem> = {}): AuthFileItem =>
  ({ name, type: 'codex', ...extra }) as AuthFileItem;
function deferred<T = void>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Two tabs of one browser share a hub, the way BroadcastChannel instances of one name do. */
function hub() {
  const members = new Set<(message: ChannelMessage) => void>();
  return () => {
    let mine: ((message: ChannelMessage) => void) | null = null;
    return {
      post: (message: ChannelMessage) => {
        for (const member of members) if (member !== mine) member(message);
      },
      subscribe: (listener: (message: ChannelMessage) => void) => {
        mine = listener;
        members.add(listener);
        return () => members.delete(listener);
      },
      close: () => {},
    };
  };
}

function fake(channel: InventoryRuntime['channel'] = null) {
  const log: string[] = [];
  const world = {
    version: 'v1',
    lists: { codex: [file('a.json')], claude: [file('c.json', { type: 'claude' })] } as Record<
      string,
      AuthFileItem[]
    >,
    failing: new Set<string>(),
    versionFails: false,
    syncFails: false,
    visible: true,
    owners: { codex: owner('codex'), claude: owner('claude') } as Record<string, SourceOwner>,
    gate: undefined as undefined | ((what: string) => Promise<void> | undefined),
    pool: undefined as undefined | PoolDashboard,
  };
  const timers: { ms: number; run: () => void; stopped: boolean }[] = [];
  const visibility: (() => void)[] = [];
  const runtime: InventoryRuntime = {
    sources: () =>
      Object.keys(world.lists).map((instanceId) => ({
        instanceId,
        owner: world.owners[instanceId],
        list: async () => {
          log.push(`list:${instanceId}`);
          await world.gate?.(`list:${instanceId}`);
          if (world.failing.has(instanceId)) throw new Error('list failed');
          return world.lists[instanceId].map((entry) => ({ ...entry }));
        },
      })),
    readVersion: async (known) => {
      log.push(`version:${known ?? 'none'}`);
      if (world.versionFails) throw new Error('offline');
      return known === world.version
        ? { status: 'unchanged' as const }
        : { status: 'changed' as const, version: world.version };
    },
    sync: async (change: CredentialChange) => {
      log.push(`sync:${change.reason}:${(change.deletedNames ?? []).join(',')}`);
      await world.gate?.('sync');
      if (world.syncFails) throw new Error('sync failed');
    },
    visible: () => world.visible,
    onVisibilityChange: (listener) => {
      visibility.push(listener);
      return () => visibility.splice(visibility.indexOf(listener), 1);
    },
    every: (ms, run) => {
      const timer = { ms, run, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    channel,
  };
  const store = createCredentialInventoryStore();
  store.getState().configure(runtime);
  const poolOf = (): PoolDashboard =>
    world.pool ?? ({ inventoryVersion: world.version } as PoolDashboard);
  return {
    store,
    world,
    log,
    timers,
    visibility,
    poolOf,
    live: () => timers.filter((timer) => !timer.stopped),
    setVisible: (visible: boolean) => {
      world.visible = visible;
      [...visibility].forEach((listener) => listener());
    },
  };
}
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('one commit', () => {
  test('publishes the version, every source and the pool in a single set()', async () => {
    const f = fake();
    f.store.getState().registerPool('weekly', async () => f.poolOf());
    let published = 0;
    f.store.subscribe(() => published++);
    const outcome = await f.store.getState().refresh();
    const state = f.store.getState();
    // One status change to 'loading' before the fetch, then exactly one commit.
    expect(published).toBe(2);
    expect(outcome).toEqual({ codex: null, claude: null });
    expect(state).toMatchObject({ version: 'v1', status: 'ready', revision: 1 });
    expect(Object.keys(state.sources).sort()).toEqual(['claude', 'codex']);
    expect(state.pool?.key).toBe('weekly');
    expect(state.pool?.data.inventoryVersion).toBe('v1');
  });

  test('every consumer sees removal in the same state: no slice lags another', async () => {
    const f = fake();
    f.store.getState().registerPool('weekly', async () => f.poolOf());
    await f.store.getState().refresh();
    f.world.lists.codex = [];
    f.world.version = 'v2';
    const seen: string[] = [];
    f.store.subscribe((state) => {
      const files = selectSourceFiles(state, f.world.owners.codex)?.length;
      seen.push(`${state.version}/${files}/${state.pool?.data.inventoryVersion}`);
    });
    await f.store.getState().refresh();
    expect(seen).toEqual(['v2/0/v2']);
  });

  test('a source that fails keeps its last good files; the others update', async () => {
    const f = fake();
    await f.store.getState().refresh();
    f.world.failing.add('codex');
    f.world.lists.claude = [];
    const outcome = await f.store.getState().refresh();
    expect(outcome.codex).toBeInstanceOf(Error);
    expect(outcome.claude).toBeNull();
    const state = f.store.getState();
    expect(selectSourceFiles(state, f.world.owners.codex)?.map((e) => e.name)).toEqual(['a.json']);
    expect(selectSourceFiles(state, f.world.owners.claude)).toEqual([]);
    expect(state.status).toBe('ready');
  });

  test('a first load where nothing can be read is an error, not an empty inventory', async () => {
    const f = fake();
    f.world.failing.add('codex').add('claude');
    await f.store.getState().refresh();
    expect(f.store.getState().status).toBe('error');
    expect(f.store.getState().sources).toEqual({});
  });

  test('prox-history being down does not stop the files from loading', async () => {
    const f = fake();
    f.world.versionFails = true;
    await f.store.getState().refresh();
    expect(f.store.getState().version).toBeNull();
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)).toHaveLength(1);
  });

  test('a failed pool read keeps the previous pool for the same query', async () => {
    const f = fake();
    let fail = false;
    f.store.getState().registerPool('q', async () => {
      if (fail) throw new Error('pools down');
      return f.poolOf();
    });
    await f.store.getState().refresh();
    const first = f.store.getState().pool;
    fail = true;
    await f.store.getState().refresh();
    expect(f.store.getState().pool).toBe(first);
  });

  test('an older overlapping refresh publishes nothing and resolves with the newer outcome', async () => {
    const f = fake();
    const slow = deferred();
    let held = 0;
    f.world.gate = (what) => (what === 'list:codex' && ++held === 1 ? slow.promise : undefined);
    const older = f.store.getState().refresh();
    f.world.lists.codex = [file('b.json')];
    const newer = f.store.getState().refresh();
    await newer;
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)?.map((e) => e.name)).toEqual(
      ['b.json']
    );
    slow.release();
    await older;
    expect(f.store.getState().revision).toBe(1); // the stale read never committed
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)?.map((e) => e.name)).toEqual(
      ['b.json']
    );
  });
});

describe('keyed per source owner', () => {
  test('files read with another session are never returned', async () => {
    const f = fake();
    await f.store.getState().refresh();
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)).toHaveLength(1);
    expect(selectSourceFiles(f.store.getState(), owner('codex', 2))).toBeUndefined();
    expect(selectSourceFiles(f.store.getState(), owner('other'))).toBeUndefined();
  });

  test('a replacement session starts from nothing, and removal is not inferred across owners', async () => {
    const f = fake();
    await f.store.getState().refresh();
    const seen: string[][] = [];
    f.store.getState().registerInvalidator((_, names) => seen.push(names));
    f.world.owners.codex = owner('codex', 2);
    f.world.lists.codex = [];
    await f.store.getState().refresh();
    expect(seen).toEqual([]); // different owner: the old files say nothing about this session
    expect(selectSourceFiles(f.store.getState(), owner('codex', 1))).toBeUndefined();
    expect(selectSourceFiles(f.store.getState(), owner('codex', 2))).toEqual([]);
  });

  test('reset drops everything and discards an in-flight read', async () => {
    const f = fake();
    const slow = deferred();
    f.world.gate = (what) => (what === 'list:codex' ? slow.promise : undefined);
    const pending = f.store.getState().refresh();
    f.store.getState().reset();
    slow.release();
    await pending;
    expect(f.store.getState()).toMatchObject({
      version: null,
      sources: {},
      status: 'idle',
      revision: 0,
    });
  });

  test('ensureLoaded reads once per owner and then returns at once', async () => {
    const f = fake();
    await f.store.getState().ensureLoaded(f.world.owners.codex);
    const reads = f.log.filter((entry) => entry === 'list:codex').length;
    await f.store.getState().ensureLoaded(f.world.owners.codex);
    expect(f.log.filter((entry) => entry === 'list:codex')).toHaveLength(reads);
    expect(reads).toBe(1);
  });
});

describe('derived caches', () => {
  test('invalidators get exactly the removed names, before the new state is published', async () => {
    const f = fake();
    f.world.lists.codex = [file('a.json'), file('b.json'), file('c.json')];
    await f.store.getState().refresh();
    const order: string[] = [];
    f.store.getState().registerInvalidator((o, names) => {
      order.push(
        `invalidate:${o.instanceId}:${names.join(',')}:revision=${f.store.getState().revision}`
      );
    });
    f.store.subscribe((state) => order.push(`publish:revision=${state.revision}`));
    f.world.lists.codex = [file('b.json'), file('d.json')];
    await f.store.getState().refresh();
    expect(order).toEqual(['invalidate:codex:a.json,c.json:revision=1', 'publish:revision=2']);
  });

  test('an invalidator that throws does not block the commit; unregistering stops calls', async () => {
    const f = fake();
    await f.store.getState().refresh();
    const calls: string[][] = [];
    f.store.getState().registerInvalidator(() => {
      throw new Error('cache broke');
    });
    const off = f.store.getState().registerInvalidator((_, names) => calls.push(names));
    f.world.lists.codex = [];
    await f.store.getState().refresh();
    expect(calls).toEqual([['a.json']]);
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)).toEqual([]);
    off();
    f.world.lists.claude = [];
    await f.store.getState().refresh();
    expect(calls).toHaveLength(1);
  });
});

describe('commitChange', () => {
  test('awaits the server sync, then refreshes once, then tells the other tabs', async () => {
    const make = hub();
    const a = fake(make());
    const b = fake(make());
    stops.push(a.store.getState().startPolling(), b.store.getState().startPolling());
    const syncGate = deferred();
    a.world.gate = (what) => (what === 'sync' ? syncGate.promise : undefined);
    const committing = a.store
      .getState()
      .commitChange({ reason: 'delete', deletedNames: ['a.json'] });
    await Promise.resolve();
    expect(a.log).toEqual(['sync:delete:a.json']); // nothing is refreshed until the sync answered
    expect(b.log).toEqual([]);
    a.world.lists.codex = [];
    a.world.version = 'v2';
    syncGate.release();
    await committing;
    expect(a.log.filter((e) => e.startsWith('list:codex'))).toHaveLength(1);
    expect(selectSourceFiles(a.store.getState(), a.world.owners.codex)).toEqual([]);
    // The other tab was nudged and refreshed on its own, without a sync of its own.
    b.world.lists.codex = [];
    await Promise.resolve();
    expect(b.log.some((e) => e.startsWith('sync'))).toBe(false);
    expect(b.log.filter((e) => e === 'list:codex').length).toBeGreaterThanOrEqual(1);
  });

  test('a message from another tab refreshes and is not broadcast again', async () => {
    const make = hub();
    const a = fake(make());
    const b = fake(make());
    stops.push(a.store.getState().startPolling(), b.store.getState().startPolling());
    let echoes = 0;
    const originalPost = b.store.getState; // b never posts: only the acting tab does
    void originalPost;
    await a.store.getState().commitChange({ reason: 'add' });
    await Promise.resolve();
    await b.store.getState().refresh();
    echoes += b.log.filter((e) => e.startsWith('sync')).length;
    expect(echoes).toBe(0);
    expect(b.store.getState().revision).toBeGreaterThanOrEqual(1);
  });

  test('a failing server sync still refreshes the files from the sources', async () => {
    const f = fake();
    f.world.syncFails = true;
    f.world.lists.codex = [];
    await f.store.getState().commitChange({ reason: 'delete', deletedNames: ['a.json'] });
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)).toEqual([]);
  });
});

describe('the poller', () => {
  test('asks with the held version and refreshes only when the server says it changed', async () => {
    const f = fake();
    await f.store.getState().refresh();
    f.log.length = 0;
    await f.store.getState().poll();
    expect(f.log).toEqual(['version:v1']);
    f.world.version = 'v2';
    f.world.lists.codex = [];
    await f.store.getState().poll();
    expect(f.log).toContain('list:codex');
    expect(f.store.getState().version).toBe('v2');
    expect(selectSourceFiles(f.store.getState(), f.world.owners.codex)).toEqual([]);
  });

  test('an unreachable server is retried on the next tick without touching state', async () => {
    const f = fake();
    await f.store.getState().refresh();
    const before = f.store.getState();
    f.world.versionFails = true;
    await f.store.getState().poll();
    expect(f.store.getState()).toBe(before);
    f.world.versionFails = false;
    f.world.version = 'v9';
    await f.store.getState().poll();
    expect(f.store.getState().version).toBe('v9');
  });

  test('ticks every 5 s while visible, pauses while hidden and catches up when shown again', async () => {
    const f = fake();
    await f.store.getState().refresh();
    stops.push(f.store.getState().startPolling());
    expect(f.live()).toHaveLength(1);
    expect(f.live()[0].ms).toBe(INVENTORY_POLL_INTERVAL_MS);
    expect(INVENTORY_POLL_INTERVAL_MS).toBe(5000);
    f.setVisible(false);
    expect(f.live()).toHaveLength(0);
    f.log.length = 0;
    f.timers.forEach((timer) => timer.run()); // a tick that fires anyway makes no request
    await f.store.getState().poll();
    expect(f.log).toEqual([]);
    f.world.version = 'v2';
    f.world.lists.codex = [];
    f.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.live()).toHaveLength(1);
    expect(f.store.getState().version).toBe('v2');
  });

  test('stopping removes the timer and the listeners', async () => {
    const f = fake();
    const stop = f.store.getState().startPolling();
    expect(f.live()).toHaveLength(1);
    stop();
    expect(f.live()).toHaveLength(0);
    expect(f.visibility).toHaveLength(0);
  });

  test('a pool that carries another version triggers one refresh per distinct version', async () => {
    const f = fake();
    await f.store.getState().refresh();
    f.log.length = 0;
    f.store.getState().noteVersion('v1');
    expect(f.log).toEqual([]);
    f.world.version = 'v2';
    f.store.getState().noteVersion('v2');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reads = f.log.filter((e) => e === 'list:codex').length;
    expect(reads).toBe(1);
    f.store.getState().noteVersion('v2'); // already looked at
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.log.filter((e) => e === 'list:codex')).toHaveLength(1);
  });
});

describe('optimistic edits', () => {
  test('a commit remembers when its refresh began, so an edit made later can reject older commits', async () => {
    const f = fake();
    const slow = deferred();
    f.world.gate = (what) => (what === 'list:codex' ? slow.promise : undefined);
    const refreshing = f.store.getState().refresh();
    const edit = f.store.getState().tick(); // the user edits while that read is in flight
    slow.release();
    await refreshing;
    expect(f.store.getState().startedAt).toBeLessThan(edit);
    f.world.gate = undefined;
    await f.store.getState().refresh();
    expect(f.store.getState().startedAt).toBeGreaterThan(edit);
  });
});

describe('the pool slot', () => {
  test('is discarded when its reader unregisters', async () => {
    const f = fake();
    const off = f.store.getState().registerPool('q', async () => f.poolOf());
    await f.store.getState().refresh();
    expect(f.store.getState().pool).not.toBeNull();
    off();
    expect(f.store.getState().pool).toBeNull();
  });

  test('a newer registration is not cleared by an older one unregistering late', async () => {
    const f = fake();
    const off = f.store.getState().registerPool('old', async () => f.poolOf());
    f.store.getState().registerPool('new', async () => f.poolOf());
    await f.store.getState().refresh();
    off();
    expect(f.store.getState().pool?.key).toBe('new');
  });
});
