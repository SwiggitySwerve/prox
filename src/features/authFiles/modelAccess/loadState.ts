/**
 * Model access load: one machine for every slice of the shared model-access store (provider lists,
 * aliases, a provider's catalog, an account's own list, an account's reported models).
 *
 *   idle ──LOAD──▶ loading ──LOADED──▶ ready ──LOAD──▶ refreshing ──LOADED──▶ ready
 *                  loading ──FAILED──▶ error ──LOAD──▶ loading | refreshing
 *                                      refreshing ──FAILED──▶ error (keeps the last data)
 *
 * Every LOAD carries a new generation; LOADED/FAILED from an older generation are dropped (not an
 * error), so a slow response can never overwrite a newer one. Any other (state, event) pair throws
 * InvalidTransitionError. `unsupported` marks a backend without the route (HTTP 404).
 */
import { InvalidTransitionError } from './editSession';
import type { ModelAccessInventory } from './resolve';

export const LOAD_MACHINE = 'model-access-load';
/** `data-machine` of the Models screen's derived inventory state (see inventory.ts). */
export const INVENTORY_MACHINE = 'model-inventory';

export type LoadState<T> =
  | { status: 'idle'; generation: number }
  | { status: 'loading'; generation: number }
  | { status: 'ready'; generation: number; data: T }
  | { status: 'refreshing'; generation: number; data: T }
  | { status: 'error'; generation: number; message: string; unsupported: boolean; data: T | null };

export type LoadStatus = LoadState<unknown>['status'];

export type LoadEvent<T> =
  | { type: 'LOAD'; generation: number }
  | { type: 'LOADED'; generation: number; data: T }
  | { type: 'FAILED'; generation: number; message: string; unsupported?: boolean };

export const LOAD_TRANSITIONS: Record<
  LoadStatus,
  Partial<Record<LoadEvent<unknown>['type'], readonly LoadStatus[]>>
> = {
  idle: { LOAD: ['loading'] },
  loading: { LOAD: ['loading'], LOADED: ['ready'], FAILED: ['error'] },
  ready: { LOAD: ['refreshing'] },
  refreshing: { LOAD: ['refreshing'], LOADED: ['ready'], FAILED: ['error'] },
  error: { LOAD: ['loading', 'refreshing'] },
};

/** One shared idle object, so selectors over a missing slice return a stable reference. */
export const IDLE_LOAD: LoadState<never> = Object.freeze({ status: 'idle', generation: 0 });

export const loadData = <T>(state: LoadState<T>): T | null => ('data' in state ? state.data : null);

export const isLoadBusy = (state: LoadState<unknown>): boolean =>
  state.status === 'loading' || state.status === 'refreshing';

export function transitionLoad<T>(state: LoadState<T>, event: LoadEvent<T>): LoadState<T> {
  // A response for a superseded request is dropped in every state.
  if (event.type !== 'LOAD' && event.generation !== state.generation) return state;
  const allowed = LOAD_TRANSITIONS[state.status][event.type];
  if (!allowed) throw new InvalidTransitionError(LOAD_MACHINE, state.status, event.type);
  switch (event.type) {
    case 'LOAD': {
      const data = loadData(state);
      return data !== null
        ? { status: 'refreshing', generation: event.generation, data }
        : { status: 'loading', generation: event.generation };
    }
    case 'LOADED':
      return { status: 'ready', generation: event.generation, data: event.data };
    case 'FAILED':
      return {
        status: 'error',
        generation: event.generation,
        message: event.message,
        unsupported: event.unsupported === true,
        data: loadData(state),
      };
  }
}

/** The Models screen's view of one provider: derived from the store's slices (inventory.ts). */
export type InventoryLoad = LoadState<ModelAccessInventory>;

export const inventoryOf = (state: InventoryLoad): ModelAccessInventory | null => loadData(state);
