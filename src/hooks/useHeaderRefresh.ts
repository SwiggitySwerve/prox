import { useEffect } from 'react';

export type HeaderRefreshHandler = () => void | Promise<void>;
const handlers = new Map<symbol, HeaderRefreshHandler>();

/** Each mounted source registers independently; cleanup removes only its own subscription. */
export function registerHeaderRefresh(handler: HeaderRefreshHandler): () => void {
  const id = Symbol();
  handlers.set(id, handler);
  return () => {
    handlers.delete(id);
  };
}
export const triggerHeaderRefresh = async () => {
  const results = await Promise.allSettled(
    [...handlers.values()].map((handler) => Promise.resolve().then(handler))
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
};
export const useHeaderRefresh = (handler?: HeaderRefreshHandler | null, enabled = true) => {
  useEffect(() => {
    if (enabled && handler) return registerHeaderRefresh(handler);
  }, [enabled, handler]);
};
