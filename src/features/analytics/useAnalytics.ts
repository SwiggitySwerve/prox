import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';
import { createAnalyticsApi } from '@/services/api/analytics';
import { apiClient } from '@/services/api/client';
import { useAuthStore } from '@/stores/useAuthStore';
// Reuse the existing auth-transition observer, including same-credential reconnects.
import { createPoolSessionObserver } from '@/features/quotaPool/poolSession';

export function useAnalytics(query: AnalyticsQuery, refresh: number) {
  const observer = useMemo(() => createPoolSessionObserver(), []);
  const session = useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getSnapshot
  );
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const connection = useAuthStore((s) => s.connectionStatus);
  const revision = apiClient.getConnectionRevision();
  // Only a load that follows a Refresh click recomputes; filter and range changes use the warm snapshot.
  // The click is consumed when a load settles, not when it is sent, so StrictMode's re-run still recomputes.
  const appliedRefresh = useRef(refresh);
  const [result, setResult] = useState<{
    query: AnalyticsQuery;
    session: number;
    refresh: number;
    revision: number;
    data?: AnalyticsResponse;
    error?: 'unsupported' | 'unavailable' | 'failed';
  }>();
  useEffect(() => {
    if (!authenticated || connection !== 'connected') return;
    const controller = new AbortController();
    const unsubscribe = useAuthStore.subscribe(() => {
      if (observer.getSnapshot() !== session) controller.abort();
    });
    const current = () =>
      !controller.signal.aborted &&
      observer.getSnapshot() === session &&
      apiClient.getConnectionRevision() === revision;
    void createAnalyticsApi()
      .query(query, controller.signal, refresh !== appliedRefresh.current)
      .then((data) => {
        if (!current()) return;
        appliedRefresh.current = refresh;
        setResult({ query, session, refresh, revision, data });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        appliedRefresh.current = refresh;
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        setResult({
          query,
          session,
          refresh,
          revision,
          error:
            status === 404 || status === 501
              ? 'unsupported'
              : status === 503
                ? 'unavailable'
                : 'failed',
        });
      });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [query, refresh, session, observer, authenticated, connection, revision]);
  const sessionResult =
    authenticated &&
    connection === 'connected' &&
    result?.session === session &&
    result.revision === revision
      ? result
      : undefined;
  const visible =
    sessionResult?.query === query && sessionResult.refresh === refresh ? sessionResult : undefined;
  return {
    data: visible?.data,
    error: visible?.error,
    loading: !visible,
    session,
    // Keep this session's known choices usable while a different query is pending.
    filterOptions: sessionResult?.data?.filter_options,
  };
}
