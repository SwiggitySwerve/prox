import type { PoolDashboard } from '@/domain/quotaPool/types';
import type { createQuotaPoolApi, PoolQuery, PoolRefresh } from '@/services/api/quotaPool';

interface PoolSnapshot {
  data: PoolDashboard | null;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  refreshError: boolean;
  refreshStatus: PoolRefresh | null;
  /** When the next once-a-minute collection fires, for the on-page countdown. */
  nextCollectAtMs: number | null;
}

const EMPTY: PoolSnapshot = {
  data: null,
  loading: true,
  refreshing: false,
  error: false,
  refreshError: false,
  refreshStatus: null,
  nextCollectAtMs: null,
};

/** Owns transport lifetime only; quota values and refresh policy belong to the server. */
export function createPoolResource(
  api: ReturnType<typeof createQuotaPoolApi>,
  query: PoolQuery,
  isCurrent: () => boolean
) {
  let snapshot = EMPTY;
  let active = false;
  let generation = 0;
  let read: AbortController | undefined;
  let mutation: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let collector: ReturnType<typeof setInterval> | undefined;
  let completionPoll: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<PoolSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const reload = async () => {
    if (!active || !isCurrent()) return;
    clearTimeout(completionPoll);
    read?.abort();
    const controller = new AbortController();
    read = controller;
    const request = ++generation;
    const valid = () =>
      active && isCurrent() && request === generation && !controller.signal.aborted;
    publish({ loading: true });
    try {
      const data = await api.get(query, controller.signal);
      if (valid()) {
        publish({ data, error: false, loading: false, refreshStatus: null });
        // Collection is asynchronous. Observe its completion promptly instead of leaving
        // a finished job looking busy until the ordinary 15-second dashboard poll.
        // These reads never request another collection and never overlap a pending read.
        if (data.refreshing) completionPoll = setTimeout(() => void reload(), 1_000);
      }
    } catch {
      if (valid()) publish({ error: true, loading: false });
    }
  };
  const refresh = async () => {
    if (!active || !isCurrent()) return false;
    if (mutation) return true;
    const controller = new AbortController();
    mutation = controller;
    publish({ refreshing: true, refreshError: false });
    try {
      const refreshStatus = await api.refresh(controller.signal);
      if (!active || !isCurrent() || controller.signal.aborted) return false;
      publish({ refreshStatus });
      await reload();
      return !snapshot.error;
    } catch {
      if (active && isCurrent() && !controller.signal.aborted) publish({ refreshError: true });
      return false;
    } finally {
      if (mutation === controller) mutation = undefined;
      if (active && isCurrent() && !controller.signal.aborted) publish({ refreshing: false });
    }
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    reload,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!active) {
        active = true;
        void reload();
        timer = setInterval(() => {
          // A slow backend must get a chance to finish before the next poll.
          if (!snapshot.loading) void reload();
        }, 15_000);
        // While graphs are on screen, ask the server to collect fresh usage every minute
        // (the server's own schedule is 5 minutes and it allows one collection per 4 minutes).
        publish({ nextCollectAtMs: Date.now() + 60_000 });
        collector = setInterval(() => {
          publish({ nextCollectAtMs: Date.now() + 60_000 });
          const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
          if (visible && snapshot.data?.pools.length) void refresh();
        }, 60_000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        active = false;
        generation += 1;
        read?.abort();
        mutation?.abort();
        mutation = undefined;
        clearInterval(timer);
        clearInterval(collector);
        clearTimeout(completionPoll);
        // Discard revealed data on privacy/filter/session changes and unmount.
        snapshot = EMPTY;
      };
    },
  };
}
