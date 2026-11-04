/**
 * The one client-side copy of the credential inventory.
 *
 * Every metadata screen (Auth Files, Accounts, Quota Management, Dashboard counts, the sidebar
 * badge, the OAuth edit pages) reads credential files from here instead of listing them itself.
 * A refresh fetches the inventory version, every source's credential files and the pool dashboard
 * in parallel and publishes all of them in a single `set()`, so no screen can show a credential
 * another screen has already dropped.
 *
 * Changes arrive three ways: the acting tab awaits the server sync and refreshes at once
 * (`commitChange`), other tabs hear it on a BroadcastChannel, and anything else (another device,
 * a file changed outside Prox) is found by the 5 s ETag poll. The server is the source of truth:
 * an event only says "look again".
 */
import { create } from 'zustand';
import type { PoolDashboard } from '@/domain/quotaPool/types';
import { sourceOwnerKey, type SourceOwner } from '@/services/api/sourceSession';
import type { AuthFileItem } from '@/types';

export const INVENTORY_POLL_INTERVAL_MS = 5000;

export interface CredentialChange {
  reason: 'add' | 'delete' | 'change';
  /** Credential file names the user deleted; only a `delete` may use them. */
  deletedNames?: string[];
}

export interface InventorySourceTarget {
  readonly instanceId: string;
  readonly owner: SourceOwner;
  list(): Promise<AuthFileItem[]>;
}

export type ChannelMessage = { type: 'changed' };

/** Everything the store needs from the outside world; faked in tests. */
export interface InventoryRuntime {
  sources(): readonly InventorySourceTarget[];
  /** With a known version the server may answer "unchanged" (HTTP 304). */
  readVersion(
    known: string | null
  ): Promise<{ status: 'unchanged' } | { status: 'changed'; version: string }>;
  sync(change: CredentialChange): Promise<void>;
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  every(ms: number, run: () => void): () => void;
  channel: {
    post(message: ChannelMessage): void;
    subscribe(listener: (message: ChannelMessage) => void): () => void;
    close(): void;
  } | null;
}

interface SourceSlice {
  /** The session the files were read with; a different owner's files are never shown. */
  readonly ownerKey: string;
  readonly files: AuthFileItem[];
}

/** Per source: null when its files were read, the error when they were not. */
export type RefreshOutcome = Record<string, Error | null>;
type Invalidator = (owner: SourceOwner, removedNames: string[]) => void;

export interface CredentialInventoryState {
  /** Membership version the last commit was built from; null until the server has answered. */
  version: string | null;
  /** Counts commits, so a consumer can tell that something new was published. */
  revision: number;
  /** Logical time the refresh behind the current commit began (see `tick`). */
  startedAt: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  sources: Readonly<Record<string, SourceSlice>>;
  /** The registered query's pool; `revision` is the commit that read it (kept pools keep theirs). */
  pool: { key: string; data: PoolDashboard; revision: number } | null;

  configure(runtime: InventoryRuntime | null): void;
  refresh(): Promise<RefreshOutcome>;
  /** Loads once if this owner has no files yet; otherwise returns at once. */
  ensureLoaded(owner: SourceOwner): Promise<void>;
  /** After the user added, removed or changed credentials: sync the server, refresh, broadcast. */
  commitChange(change: CredentialChange): Promise<void>;
  poll(): Promise<void>;
  startPolling(): () => void;
  /**
   * A logical clock shared by refreshes and local edits. A screen with optimistic edits stamps
   * each edit with `tick()` and ignores commits whose `startedAt` is older: such a commit was
   * requested before the edit and may not reflect it.
   */
  tick(): number;
  registerInvalidator(invalidate: Invalidator): () => void;
  registerPool(key: string, read: (signal: AbortSignal) => Promise<PoolDashboard>): () => void;
  /** A pool read carried this inventory version; look again if it is not the committed one. */
  noteVersion(version: string): void;
  reset(): void;
}

const INITIAL: Pick<
  CredentialInventoryState,
  'version' | 'revision' | 'startedAt' | 'status' | 'sources' | 'pool'
> = { version: null, revision: 0, startedAt: 0, status: 'idle', sources: {}, pool: null };

const toError = (reason: unknown) =>
  reason instanceof Error ? reason : new Error('Request failed');
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: toError(error) })
  );

export function createCredentialInventoryStore() {
  let runtime: InventoryRuntime | null = null;
  let requestSeq = 0;
  let clock = 0;
  let running: Promise<RefreshOutcome> | null = null;
  let latest: Promise<RefreshOutcome> = Promise.resolve({});
  let polling = false;
  let lastNotedVersion: string | null = null;
  let poolRegistration: {
    key: string;
    read: (signal: AbortSignal) => Promise<PoolDashboard>;
  } | null = null;
  const invalidators = new Set<Invalidator>();

  return create<CredentialInventoryState>()((set, get) => ({
    ...INITIAL,

    configure: (next) => {
      runtime = next;
    },

    tick: () => ++clock,

    refresh: () => {
      if (!runtime) return Promise.resolve({});
      const active = runtime;
      const request = ++requestSeq;
      const startedAt = ++clock;
      const targets = active.sources();
      const reader = poolRegistration;
      if (get().status === 'idle') set({ status: 'loading' });
      const run = (async (): Promise<RefreshOutcome> => {
        const abort = new AbortController();
        const [version, lists, pool] = await Promise.all([
          settle(active.readVersion(null)),
          Promise.all(targets.map((target) => settle(target.list()))),
          reader ? settle(reader.read(abort.signal)) : Promise.resolve(null),
        ]);
        // A newer refresh began meanwhile; its commit will be the fresher one.
        if (request !== requestSeq) {
          abort.abort();
          return latest;
        }

        const before = get();
        const sources: Record<string, SourceSlice> = {};
        const outcome: RefreshOutcome = {};
        const removed: [SourceOwner, string[]][] = [];
        targets.forEach((target, index) => {
          const ownerKey = sourceOwnerKey(target.owner);
          const previous = before.sources[target.instanceId];
          const kept = previous?.ownerKey === ownerKey ? previous : undefined;
          const result = lists[index];
          if (result.ok) {
            sources[target.instanceId] = { ownerKey, files: result.value };
            outcome[target.instanceId] = null;
            if (kept) {
              const present = new Set(result.value.map((file) => file.name));
              const gone = kept.files.map((file) => file.name).filter((name) => !present.has(name));
              if (gone.length) removed.push([target.owner, gone]);
            }
          } else {
            // A failed read erases nothing: the last good files stay until a read succeeds.
            outcome[target.instanceId] = result.error;
            if (kept) sources[target.instanceId] = kept;
          }
        });
        const nextPool =
          reader && pool?.ok
            ? { key: reader.key, data: pool.value, revision: before.revision + 1 }
            : reader && before.pool?.key === reader.key
              ? before.pool
              : null;
        // Derived caches (model lists, quota readings) drop what disappeared in the same step
        // that publishes the new files.
        for (const [owner, names] of removed) {
          for (const invalidate of invalidators) {
            try {
              invalidate(owner, names);
            } catch {
              // One cache failing to clear must not block the commit.
            }
          }
        }
        set({
          version:
            version.ok && version.value.status === 'changed'
              ? version.value.version
              : before.version,
          revision: before.revision + 1,
          startedAt,
          status: Object.keys(sources).length > 0 || targets.length === 0 ? 'ready' : 'error',
          sources,
          pool: nextPool,
        });
        return outcome;
      })();
      latest = run;
      running = run;
      void run.finally(() => {
        if (running === run) running = null;
      });
      return run;
    },

    ensureLoaded: async (owner) => {
      const has = () => {
        const slice = get().sources[owner.instanceId];
        return slice?.ownerKey === sourceOwnerKey(owner);
      };
      if (has()) return;
      if (running) await running.catch(() => undefined);
      if (!has()) await get().refresh();
    },

    commitChange: async (change) => {
      if (!runtime) return;
      const active = runtime;
      try {
        await active.sync(change);
      } catch {
        // prox-history may be down. The files still come straight from CLI-Proxy below.
      }
      await get().refresh();
      active.channel?.post({ type: 'changed' });
    },

    poll: async () => {
      if (!runtime || polling || !runtime.visible()) return;
      polling = true;
      try {
        const answer = await runtime.readVersion(get().version);
        if (answer.status === 'changed' && answer.version !== get().version) await get().refresh();
      } catch {
        // The server is unreachable; the next tick tries again.
      } finally {
        polling = false;
      }
    },

    startPolling: () => {
      const active = runtime;
      if (!active) return () => undefined;
      let stopTimer: (() => void) | null = null;
      const start = () => {
        stopTimer ??= active.every(INVENTORY_POLL_INTERVAL_MS, () => void get().poll());
      };
      const stop = () => {
        stopTimer?.();
        stopTimer = null;
      };
      const unwatch = active.onVisibilityChange(() => {
        if (active.visible()) {
          void get().poll(); // catch up on whatever changed while hidden
          start();
        } else {
          stop();
        }
      });
      const unlisten = active.channel?.subscribe(() => void get().refresh());
      if (active.visible()) start();
      return () => {
        stop();
        unwatch();
        unlisten?.();
      };
    },

    registerInvalidator: (invalidate) => {
      invalidators.add(invalidate);
      return () => {
        invalidators.delete(invalidate);
      };
    },

    registerPool: (key, read) => {
      const registration = { key, read };
      poolRegistration = registration;
      return () => {
        if (poolRegistration !== registration) return;
        poolRegistration = null;
        // Revealed pool data is discarded as soon as nothing displays it.
        if (get().pool?.key === key) set({ pool: null });
      };
    },

    noteVersion: (version) => {
      const known = get().version;
      if (known === null || version === known || version === lastNotedVersion || running) return;
      lastNotedVersion = version;
      void get().refresh();
    },

    reset: () => {
      requestSeq += 1;
      running = null;
      latest = Promise.resolve({});
      lastNotedVersion = null;
      set({ ...INITIAL });
    },
  }));
}

export const useCredentialInventoryStore = createCredentialInventoryStore();

export function selectSourceFiles(
  state: Pick<CredentialInventoryState, 'sources'>,
  owner: SourceOwner
): AuthFileItem[] | undefined {
  const slice = state.sources[owner.instanceId];
  return slice?.ownerKey === sourceOwnerKey(owner) ? slice.files : undefined;
}

/** This owner's credential files, or undefined until they have been read. */
export function useSourceFiles(owner: SourceOwner | null | undefined): AuthFileItem[] | undefined {
  return useCredentialInventoryStore((state) =>
    owner ? selectSourceFiles(state, owner) : undefined
  );
}
