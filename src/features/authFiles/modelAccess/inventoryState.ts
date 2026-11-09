/**
 * Model inventory load: one provider's lists, catalog and per-account reads, loaded together.
 *
 *   idle ──LOAD──▶ loading ──LOADED──▶ ready ──LOAD──▶ refreshing ──LOADED──▶ ready
 *                  loading ──FAILED──▶ error ──LOAD──▶ loading
 *                                      refreshing ──FAILED──▶ error (keeps the last inventory)
 *
 * Every LOAD carries a new generation; LOADED/FAILED from an older generation are dropped (not an
 * error), so switching provider or source can never show the previous one's data. Any other
 * (state, event) pair throws InvalidTransitionError. UI: `data-machine="model-inventory"`.
 */
import { InvalidTransitionError } from './editSession';
import type { ModelAccessInventory } from './resolve';

export const INVENTORY_MACHINE = 'model-inventory';

export type InventoryLoad =
  | { status: 'idle'; generation: number }
  | { status: 'loading'; generation: number }
  | { status: 'ready'; generation: number; inventory: ModelAccessInventory }
  | { status: 'refreshing'; generation: number; inventory: ModelAccessInventory }
  | {
      status: 'error';
      generation: number;
      message: string;
      inventory: ModelAccessInventory | null;
    };

export type InventoryEvent =
  | { type: 'LOAD'; generation: number }
  | { type: 'LOADED'; generation: number; inventory: ModelAccessInventory }
  | { type: 'FAILED'; generation: number; message: string };

export const INVENTORY_TRANSITIONS: Record<
  InventoryLoad['status'],
  Partial<Record<InventoryEvent['type'], readonly InventoryLoad['status'][]>>
> = {
  idle: { LOAD: ['loading'] },
  loading: { LOAD: ['loading'], LOADED: ['ready'], FAILED: ['error'] },
  ready: { LOAD: ['refreshing'] },
  refreshing: { LOAD: ['refreshing'], LOADED: ['ready'], FAILED: ['error'] },
  error: { LOAD: ['loading', 'refreshing'] },
};

export const INITIAL_INVENTORY_LOAD: InventoryLoad = { status: 'idle', generation: 0 };

export function transitionInventory(state: InventoryLoad, event: InventoryEvent): InventoryLoad {
  // A response for a superseded request is dropped in every state.
  if (event.type !== 'LOAD' && event.generation !== state.generation) return state;
  const allowed = INVENTORY_TRANSITIONS[state.status][event.type];
  if (!allowed) throw new InvalidTransitionError(INVENTORY_MACHINE, state.status, event.type);
  switch (event.type) {
    case 'LOAD': {
      const inventory = 'inventory' in state ? state.inventory : null;
      return inventory
        ? { status: 'refreshing', generation: event.generation, inventory }
        : { status: 'loading', generation: event.generation };
    }
    case 'LOADED':
      return { status: 'ready', generation: event.generation, inventory: event.inventory };
    case 'FAILED':
      return {
        status: 'error',
        generation: event.generation,
        message: event.message,
        inventory: 'inventory' in state ? state.inventory : null,
      };
  }
}

export const inventoryOf = (state: InventoryLoad): ModelAccessInventory | null =>
  'inventory' in state ? state.inventory : null;
