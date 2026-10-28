import type { ResolvedSource } from '@/domain/providerSources/types';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';
import { subscribeSourceConfigChanges } from '@/services/api/sourceConfigChanges';
import { createSourceLease } from '@/services/api/sourceLease';
import { createProvidersApi } from '@/services/api/providers';
import { createConfigApi } from '@/services/api/config';
import { createModelsApi } from '@/services/api/models';
import { createApiKeysApi } from '@/services/api/apiKeys';
import { createApiKeyUsageApi } from '@/services/api/apiKeyUsage';
import { createApiCallApi } from '@/services/api/apiCall';
import { createConfigStore } from '@/stores/useConfigStore';
import { createModelsStore } from '@/stores/useModelsStore';
import { createProviderRecentRequestsCache } from '@/components/providers/recentRequests';

/** One panel owns its APIs, stores, drafts and pending confirmations for its entire lifetime. */
export function createProviderSourceScope(owner: SourceSession, source: ResolvedSource) {
  if (owner.owner.instanceId !== source.instanceId)
    throw new Error('Provider source owner mismatch');
  const lease = createSourceLease(owner);
  const { session, assertCurrent, isCurrent } = lease;
  const configApi = createConfigApi(session);
  const modelsApi = createModelsApi(session, { modelsUrl: `${source.apiBase}/v1/models` });
  const configStore = createConfigStore(configApi);
  const modelsStore = createModelsStore(modelsApi);
  const recentRequestsCache = createProviderRecentRequestsCache();
  const clear = () => {
    configStore.getState().clearCache();
    modelsStore.getState().clearCache();
    Object.assign(recentRequestsCache, createProviderRecentRequestsCache());
  };
  let unsubscribe: (() => void) | undefined;
  const invalidate = (changed: SourceSession['owner']) => {
    if (!isCurrent() || sourceOwnerKey(changed) !== sourceOwnerKey(owner.owner)) return;
    // Retain the displayed config while invalidating its cache and any pending old reads.
    configStore.getState().clearCache('api-keys');
    modelsStore.getState().clearCache();
    Object.assign(recentRequestsCache, createProviderRecentRequestsCache());
  };
  return Object.freeze({
    source,
    session,
    providersApi: createProvidersApi(session),
    configApi,
    modelsApi,
    apiKeysApi: createApiKeysApi(session),
    apiKeyUsageApi: createApiKeyUsageApi(session),
    apiCallApi: createApiCallApi(session),
    configStore,
    modelsStore,
    recentRequestsCache,
    assertCurrent,
    isCurrent,
    getRevision: lease.getRevision,
    activate: () => {
      lease.activate();
      owner.signal.addEventListener('abort', clear);
      unsubscribe ??= subscribeSourceConfigChanges(invalidate);
    },
    dispose: () => {
      lease.dispose();
      unsubscribe?.();
      unsubscribe = undefined;
      owner.signal.removeEventListener('abort', clear);
      clear();
    },
  });
}

export type ProviderSourceScope = ReturnType<typeof createProviderSourceScope>;
