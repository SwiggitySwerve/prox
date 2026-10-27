import { useMemo, useSyncExternalStore } from 'react';
import { apiClient } from '@/services/api/client';
import { createQuotaPoolApi, type PoolQuery } from '@/services/api/quotaPool';
import { useAuthStore } from '@/stores/useAuthStore';
import { createPoolResource } from './poolResource';
import { createPoolSessionObserver } from './poolSession';

export function usePoolDashboard(query: PoolQuery) {
  const session = useMemo(() => createPoolSessionObserver(), []);
  const generation = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const connection = useAuthStore((state) => state.connectionStatus);
  const revision = apiClient.getConnectionRevision();
  const { window, lookback, multiplier, offsetDays, reveal } = query;
  const resource = useMemo(
    () =>
      createPoolResource(
        createQuotaPoolApi(),
        { window, lookback, multiplier, offsetDays, reveal },
        () => {
          const current = useAuthStore.getState();
          return (
            authenticated &&
            connection === 'connected' &&
            current.isAuthenticated &&
            current.connectionStatus === connection &&
            current.apiBase === apiBase &&
            current.managementKey === managementKey &&
            session.getSnapshot() === generation &&
            apiClient.getConnectionRevision() === revision
          );
        }
      ),
    [
      apiBase,
      managementKey,
      authenticated,
      connection,
      revision,
      session,
      generation,
      window,
      lookback,
      multiplier,
      offsetDays,
      reveal,
    ]
  );
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getServerSnapshot
  );
  return {
    ...snapshot,
    reload: resource.reload,
    refresh: resource.refresh,
    connected: authenticated && connection === 'connected',
  };
}
