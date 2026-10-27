import { useSyncExternalStore } from 'react';
import { SourceRegistry } from '@/services/providerSources/registry';
import { apiClient } from '@/services/api/client';
import { useAuthStore } from './useAuthStore';

export const providerSources = new SourceRegistry();
let connectionRevision = -1;
let active = false;

function synchronize() {
  const auth = useAuthStore.getState();
  const ready = auth.isAuthenticated && auth.connectionStatus === 'connected';
  const revision = apiClient.getConnectionRevision();
  if (!ready) {
    if (active) providerSources.reset();
    active = false;
    return;
  }
  if (active && revision === connectionRevision) return;
  active = true;
  connectionRevision = revision;
  void providerSources.connect(auth.apiBase, auth.managementKey, window.location.origin);
}
// Reset synchronously on logout/login start, before delayed work can dispatch.
if (typeof window !== 'undefined') {
  useAuthStore.subscribe(synchronize);
  synchronize();
}
export function useProviderSources() {
  return useSyncExternalStore(
    providerSources.subscribe,
    providerSources.getSnapshot,
    providerSources.getSnapshot
  );
}
