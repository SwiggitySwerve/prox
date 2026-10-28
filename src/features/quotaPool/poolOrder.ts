import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type PoolIdentity = { provider: string; instanceId?: string };

export const poolKey = (pool: PoolIdentity) => `${pool.instanceId ?? 'legacy'}:${pool.provider}`;

/** Pools in the saved order; pools the order does not name keep the server's order after them. */
export function orderPools<T extends PoolIdentity>(
  pools: readonly T[],
  order: readonly string[]
): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return pools
    .map((pool, index) => ({ pool, index, rank: rank.get(poolKey(pool)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ pool }) => pool);
}

/** The order after moving one of the shown pools by delta places. */
export function movePool(shown: readonly PoolIdentity[], key: string, delta: -1 | 1): string[] {
  const keys = shown.map(poolKey);
  const from = keys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= keys.length) return keys;
  [keys[from], keys[to]] = [keys[to], keys[from]];
  return keys;
}

export const usePoolOrder = create<{ order: string[]; setOrder: (order: string[]) => void }>()(
  persist((set) => ({ order: [], setOrder: (order) => set({ order }) }), {
    name: 'prox-pool-order',
  })
);
