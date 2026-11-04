import { useMemo, useSyncExternalStore } from 'react';
import { apiClient } from '@/services/api/client';
import { createQuotaPoolApi, type PoolQuery } from '@/services/api/quotaPool';
import { useAuthStore } from '@/stores/useAuthStore';
import { useCredentialInventoryStore } from '@/stores/useCredentialInventoryStore';
import { createPoolResource, type PoolInventoryLink } from './poolResource';
import { createPoolSessionObserver } from './poolSession';

/** The pool is read inside the credential inventory's refresh, so it commits with the files. */
const inventoryLink: PoolInventoryLink = {
  attach: (key, read) => useCredentialInventoryStore.getState().registerPool(key, read),
  committed: (key) => {
    const { pool } = useCredentialInventoryStore.getState();
    return pool?.key === key ? { data: pool.data, revision: pool.revision } : null;
  },
  subscribe: (listener) => useCredentialInventoryStore.subscribe(listener),
  noteVersion: (version) => useCredentialInventoryStore.getState().noteVersion(version),
};

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
        },
        inventoryLink
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
