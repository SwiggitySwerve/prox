import { apiCallApi } from '@/services/api/apiCall';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import { guardConfigConnection } from '@/services/api/configValue';
import { antigravitySubscriptionApi } from '@/services/api/antigravitySubscription';
import { resolveKimiQuotaUrl } from '@/services/api/kimiQuota';
import type { QuotaDependencies } from '@/features/quota/providers/dependencies';
import { pluginsApi } from '@/services/api/plugins';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
} from '@/stores/useQuotaStore';

export const testQuotaDependencies: QuotaDependencies = {
  apiCallApi,
  authFilesApi,
  management: apiClient,
  guardConfigConnection,
  captureCurrent: (name) => {
    const generation = captureQuotaCacheGeneration(name);
    return () => commitIfQuotaCacheCurrent(generation, () => {});
  },
  generation: (name) => {
    const state = useQuotaStore.getState();
    return { session: state.cacheGeneration, file: state.fileGenerations[name] ?? 0 };
  },
  revision: () => apiClient.getConnectionRevision(),
  loadPlugins: () => pluginsApi.list(),
  antigravitySubscriptionApi,
  resolveKimiQuotaUrl: (file) => resolveKimiQuotaUrl(file, authFilesApi),
};
