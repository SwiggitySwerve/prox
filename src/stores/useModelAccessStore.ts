/**
 * The one client-side copy of model-access data: which models each credential serves, and why.
 *
 * Per source it holds the provider exclusion lists, the model aliases, each provider's catalog,
 * and per credential its own exclusion list and the models the hub reports for it. Every screen
 * that shows any of this (the Models matrix, the Auth Files summary, the per-account models
 * dialog, the credential sheet's exclusion field, the alias card and the alias editor) reads these
 * slices instead of fetching its own copy, so a change made on one screen is what every other
 * screen shows.
 *
 * Each slice is a LoadState (features/authFiles/modelAccess/loadState.ts): a newer request always
 * supersedes an older one, and a failed re-read keeps the last good data. `ensure*` loads a slice
 * that is missing or older than MODEL_ACCESS_MAX_AGE_MS; `{ force: true }` always re-reads (the
 * Refresh button, and after every write). The server is the source of truth: writes go to the
 * hub first and the affected slices are re-read, never patched optimistically.
 */
import { create } from 'zustand';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { InvalidTransitionError } from '@/features/authFiles/modelAccess/editSession';
import type { AccountRef, SourceModelAccess } from '@/features/authFiles/modelAccess/inventory';
import {
  IDLE_LOAD,
  transitionLoad,
  type LoadEvent,
  type LoadState,
} from '@/features/authFiles/modelAccess/loadState';
import { sourceOwnerKey, type SourceOwner } from '@/services/api/sourceSession';
import type { OAuthModelAliasEntry } from '@/types';

export const MODEL_ACCESS_MAX_AGE_MS = 30_000;
/** Parallel per-account reads: quick, without flooding a hub. */
const ACCOUNT_READ_CONCURRENCY = 4;

/** The reads the store needs from one source; faked in tests. */
export interface ModelAccessSourceApi {
  getProviderLists(): Promise<Record<string, string[]>>;
  getAliases(): Promise<Record<string, OAuthModelAliasEntry[]>>;
  getCatalog(provider: string): Promise<AuthFileModelItem[]>;
  getAccountList(name: string): Promise<string[] | null>;
  getAccountModels(name: string): Promise<AuthFileModelItem[]>;
}

export interface ModelAccessRuntime {
  /** The live session's reads, or null when that source is no longer signed in. */
  api(owner: SourceOwner): ModelAccessSourceApi | null;
  now(): number;
}

export type EnsureOptions = { force?: boolean };

type Slot =
  | { group: 'providerLists' }
  | { group: 'aliases' }
  | { group: 'catalogs' | 'accountLists' | 'accountModels'; key: string };

export interface ModelAccessState {
  sources: Readonly<Record<string, SourceModelAccess>>;
  configure(runtime: ModelAccessRuntime | null): void;
  /** Provider lists and aliases. */
  ensureConfig(owner: SourceOwner, options?: EnsureOptions): Promise<void>;
  ensureCatalog(owner: SourceOwner, provider: string, options?: EnsureOptions): Promise<void>;
  /** Own list (credential files only) and reported models (enabled accounts only). */
  ensureAccounts(
    owner: SourceOwner,
    accounts: readonly AccountRef[],
    options?: EnsureOptions
  ): Promise<void>;
  /** Only what the hub reports for one credential (no file read). */
  ensureAccountModels(owner: SourceOwner, name: string, options?: EnsureOptions): Promise<void>;
  /** Only what the hub reports for these credentials, a few at a time (after a write). */
  ensureAccountsModels(
    owner: SourceOwner,
    names: readonly string[],
    options?: EnsureOptions
  ): Promise<void>;
  /** Everything one provider's screens need: config, catalog and its accounts. */
  ensureProvider(
    owner: SourceOwner,
    provider: string,
    accounts: readonly AccountRef[],
    options?: EnsureOptions
  ): Promise<void>;
  /**
   * The header refresh: re-read every slice that has been loaded, for every source, a few at a
   * time per source. A read already in flight is joined rather than sent again. Resolves to the
   * sources (instance ids) where a re-read failed; their last good data stays.
   */
  refreshLoaded(): Promise<string[]>;
  /** Forget per-account slices (all of them without names); the next ensure re-reads them. */
  invalidateAccounts(owner: SourceOwner, names?: readonly string[]): void;
  reset(): void;
}

const emptySource = (ownerKey: string): SourceModelAccess => ({
  ownerKey,
  providerLists: IDLE_LOAD,
  aliases: IDLE_LOAD,
  catalogs: {},
  accountLists: {},
  accountModels: {},
});

const slotId = (slot: Slot) => ('key' in slot ? `${slot.group}:${slot.key}` : slot.group);

function readSlot(source: SourceModelAccess | undefined, slot: Slot): LoadState<unknown> {
  if (!source) return IDLE_LOAD;
  return 'key' in slot ? (source[slot.group][slot.key] ?? IDLE_LOAD) : source[slot.group];
}

function writeSlot(
  source: SourceModelAccess,
  slot: Slot,
  state: LoadState<unknown>
): SourceModelAccess {
  return 'key' in slot
    ? { ...source, [slot.group]: { ...source[slot.group], [slot.key]: state } }
    : { ...source, [slot.group]: state };
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';
const statusOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
/** An old backend lacks the route (404); an unknown catalog channel answers 400. */
const isUnsupported = (error: unknown, slot: Slot) =>
  statusOf(error) === 404 || (slot.group === 'catalogs' && statusOf(error) === 400);

async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  await Promise.all(workers);
}

export function createModelAccessStore() {
  let runtime: ModelAccessRuntime | null = null;
  let generationSeq = 0;
  const inflight = new Map<string, Promise<void>>();
  const loadedAt = new Map<string, number>();
  /** The owner behind each ownerKey the store has data for (refreshLoaded needs the object). */
  const owners = new Map<string, SourceOwner>();

  return create<ModelAccessState>()((set, get) => {
    const sourceOf = (owner: SourceOwner): SourceModelAccess | undefined => {
      const source = get().sources[owner.instanceId];
      return source?.ownerKey === sourceOwnerKey(owner) ? source : undefined;
    };

    /** Apply one load event to one slice; an event from a replaced owner is dropped. */
    const dispatch = (owner: SourceOwner, slot: Slot, event: LoadEvent<unknown>) => {
      set((state) => {
        const ownerKey = sourceOwnerKey(owner);
        const existing = state.sources[owner.instanceId];
        let source = existing?.ownerKey === ownerKey ? existing : undefined;
        if (!source) {
          if (event.type !== 'LOAD') return state;
          // A new session for this source: the previous owner's data is never shown again.
          source = emptySource(ownerKey);
        }
        const current = readSlot(source, slot);
        let next: LoadState<unknown>;
        try {
          next = transitionLoad(current, event);
        } catch (error) {
          if (!(error instanceof InvalidTransitionError)) throw error;
          console.warn(error.message);
          return state;
        }
        if (next === current && source === existing) return state;
        return {
          sources: { ...state.sources, [owner.instanceId]: writeSlot(source, slot, next) },
        };
      });
    };

    function load<T>(
      owner: SourceOwner,
      slot: Slot,
      read: (api: ModelAccessSourceApi) => Promise<T>,
      options?: EnsureOptions
    ): Promise<void> {
      const active = runtime;
      if (!active) return Promise.resolve();
      const id = `${sourceOwnerKey(owner)}|${slotId(slot)}`;
      if (!options?.force) {
        const flight = inflight.get(id);
        if (flight) return flight;
        const current = readSlot(sourceOf(owner), slot);
        const fresh = active.now() - (loadedAt.get(id) ?? -Infinity) < MODEL_ACCESS_MAX_AGE_MS;
        if (current.status === 'ready' && fresh) return Promise.resolve();
      }
      const api = active.api(owner);
      if (!api) return Promise.resolve();
      owners.set(sourceOwnerKey(owner), owner);
      const generation = ++generationSeq;
      dispatch(owner, slot, { type: 'LOAD', generation });
      const run: Promise<void> = read(api)
        .then(
          (data) => {
            loadedAt.set(id, active.now());
            dispatch(owner, slot, { type: 'LOADED', generation, data });
          },
          (error: unknown) => {
            dispatch(owner, slot, {
              type: 'FAILED',
              generation,
              message: messageOf(error),
              unsupported: isUnsupported(error, slot),
            });
          }
        )
        .finally(() => {
          if (inflight.get(id) === run) inflight.delete(id);
        });
      inflight.set(id, run);
      return run;
    }

    /** Drop per-account slices; a response still in flight for them is ignored when it lands. */
    const forget = (
      owner: SourceOwner,
      group: 'accountLists' | 'accountModels',
      names?: readonly string[]
    ) => {
      const source = sourceOf(owner);
      if (!source) return;
      const ownerKey = sourceOwnerKey(owner);
      const gone = names ?? Object.keys(source[group]);
      for (const name of gone) {
        const id = `${ownerKey}|${group}:${name}`;
        loadedAt.delete(id);
        inflight.delete(id);
      }
      const kept = Object.fromEntries(
        Object.entries(source[group]).filter(([name]) => !gone.includes(name))
      );
      set((state) => ({
        sources: { ...state.sources, [owner.instanceId]: { ...source, [group]: kept } },
      }));
    };

    return {
      sources: {},

      configure: (next) => {
        runtime = next;
      },

      ensureConfig: async (owner, options) => {
        await Promise.all([
          load(owner, { group: 'providerLists' }, (api) => api.getProviderLists(), options),
          load(owner, { group: 'aliases' }, (api) => api.getAliases(), options),
        ]);
      },

      ensureCatalog: (owner, provider, options) =>
        provider
          ? load(
              owner,
              { group: 'catalogs', key: provider },
              (api) => api.getCatalog(provider),
              options
            )
          : Promise.resolve(),

      ensureAccounts: async (owner, accounts, options) => {
        await eachLimited(accounts, ACCOUNT_READ_CONCURRENCY, async (account) => {
          const reads: Promise<void>[] = [];
          if (account.kind === 'file') {
            reads.push(
              load(
                owner,
                { group: 'accountLists', key: account.name },
                (api) => api.getAccountList(account.name),
                options
              )
            );
          }
          if (account.disabled) {
            // A disabled account serves nothing; what it served before says nothing about what
            // it serves once re-enabled, so forget it and re-read then.
            if (sourceOf(owner)?.accountModels[account.name]) {
              forget(owner, 'accountModels', [account.name]);
            }
          } else {
            reads.push(
              load(
                owner,
                { group: 'accountModels', key: account.name },
                (api) => api.getAccountModels(account.name),
                options
              )
            );
          }
          await Promise.all(reads);
        });
      },

      ensureAccountModels: (owner, name, options) =>
        load(
          owner,
          { group: 'accountModels', key: name },
          (api) => api.getAccountModels(name),
          options
        ),

      ensureAccountsModels: (owner, names, options) =>
        eachLimited(names, ACCOUNT_READ_CONCURRENCY, (name) =>
          get().ensureAccountModels(owner, name, options)
        ),

      ensureProvider: async (owner, provider, accounts, options) => {
        await Promise.all([
          get().ensureConfig(owner, options),
          get().ensureCatalog(owner, provider, options),
          get().ensureAccounts(owner, accounts, options),
        ]);
      },

      refreshLoaded: async () => {
        const failed: string[] = [];
        await Promise.all(
          Object.entries(get().sources).map(async ([instanceId, source]) => {
            const owner = owners.get(source.ownerKey);
            if (!owner) return;
            const reads: Array<{
              slot: Slot;
              read: (api: ModelAccessSourceApi) => Promise<unknown>;
            }> = [];
            const loaded = (state: LoadState<unknown> | undefined) =>
              state !== undefined && state.status !== 'idle';
            if (loaded(source.providerLists)) {
              reads.push({
                slot: { group: 'providerLists' },
                read: (api) => api.getProviderLists(),
              });
            }
            if (loaded(source.aliases)) {
              reads.push({ slot: { group: 'aliases' }, read: (api) => api.getAliases() });
            }
            for (const key of Object.keys(source.catalogs)) {
              if (!loaded(source.catalogs[key])) continue;
              reads.push({ slot: { group: 'catalogs', key }, read: (api) => api.getCatalog(key) });
            }
            for (const key of Object.keys(source.accountLists)) {
              if (!loaded(source.accountLists[key])) continue;
              reads.push({
                slot: { group: 'accountLists', key },
                read: (api) => api.getAccountList(key),
              });
            }
            for (const key of Object.keys(source.accountModels)) {
              if (!loaded(source.accountModels[key])) continue;
              reads.push({
                slot: { group: 'accountModels', key },
                read: (api) => api.getAccountModels(key),
              });
            }
            await eachLimited(reads, ACCOUNT_READ_CONCURRENCY, ({ slot, read }) => {
              const flight = inflight.get(`${source.ownerKey}|${slotId(slot)}`);
              return flight ?? load(owner, slot, read, { force: true });
            });
            const after = sourceOf(owner);
            const broken = reads.some(({ slot }) => {
              const state = readSlot(after, slot);
              return state.status === 'error' && !state.unsupported;
            });
            if (broken) failed.push(instanceId);
          })
        );
        return failed;
      },

      invalidateAccounts: (owner, names) => {
        forget(owner, 'accountLists', names);
        forget(owner, 'accountModels', names);
      },

      reset: () => {
        generationSeq += 1;
        inflight.clear();
        loadedAt.clear();
        owners.clear();
        set({ sources: {} });
      },
    };
  });
}

export const useModelAccessStore = createModelAccessStore();

export function selectSourceModelAccess(
  state: Pick<ModelAccessState, 'sources'>,
  owner: SourceOwner
): SourceModelAccess | undefined {
  const source = state.sources[owner.instanceId];
  return source?.ownerKey === sourceOwnerKey(owner) ? source : undefined;
}

/** This owner's model-access slices, or undefined until something has been requested. */
export function useSourceModelAccess(
  owner: SourceOwner | null | undefined
): SourceModelAccess | undefined {
  return useModelAccessStore((state) =>
    owner ? selectSourceModelAccess(state, owner) : undefined
  );
}
