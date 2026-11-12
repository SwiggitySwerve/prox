import { useEffect, useSyncExternalStore } from 'react';
import type { RefreshOutcome } from '@/stores/useCredentialInventoryStore';

/** What one click of the header refresh shares with the open page (headerRefreshRound.ts). */
export interface HeaderRefreshRound {
  /** This click's one read of every hub's credential list; a page uses it instead of listing. */
  readonly inventory: Promise<RefreshOutcome>;
  /** A page reports cards whose quota read failed, for the round's one summary notice. */
  quotaFailed(hub: string, count: number): void;
}
export type HeaderRefreshHandler = (round?: HeaderRefreshRound) => void | Promise<void>;
const handlers = new Map<symbol, HeaderRefreshHandler>();

/** Each mounted source registers independently; cleanup removes only its own subscription. */
export function registerHeaderRefresh(handler: HeaderRefreshHandler): () => void {
  const id = Symbol();
  handlers.set(id, handler);
  return () => {
    handlers.delete(id);
  };
}
export const triggerHeaderRefresh = async (round?: HeaderRefreshRound) => {
  const results = await Promise.allSettled(
    [...handlers.values()].map((handler) => Promise.resolve().then(() => handler(round)))
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
};
export const useHeaderRefresh = (handler?: HeaderRefreshHandler | null, enabled = true) => {
  useEffect(() => {
    if (enabled && handler) return registerHeaderRefresh(handler);
  }, [enabled, handler]);
};

// Work a page started that outlives the click (a server-side collection, a first load).
// The header refresh button shows busy until every source releases.
const busy = new Set<symbol>();
const busyListeners = new Set<() => void>();
const notifyBusy = () => busyListeners.forEach((listener) => listener());
export const isHeaderRefreshBusy = () => busy.size > 0;
export function markHeaderRefreshBusy(): () => void {
  const id = Symbol();
  busy.add(id);
  notifyBusy();
  return () => {
    if (busy.delete(id)) notifyBusy();
  };
}
export const useHeaderRefreshBusy = () =>
  useSyncExternalStore(
    (listener) => {
      busyListeners.add(listener);
      return () => busyListeners.delete(listener);
    },
    isHeaderRefreshBusy,
    () => false
  );
/** Marks the header refresh busy while `active` is true. */
export const useReportHeaderRefreshBusy = (active: boolean) => {
  useEffect(() => {
    if (active) return markHeaderRefreshBusy();
  }, [active]);
};
