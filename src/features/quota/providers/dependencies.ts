import type { AuthFileItem } from '@/types';
import { apiCallApi, createApiCallApi } from '@/services/api/apiCall';
import { authFilesApi, createAuthFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import { guardConfigConnection } from '@/services/api/configValue';
import { antigravitySubscriptionApi } from '@/services/api/antigravitySubscription';
import { resolveKimiQuotaUrl } from '@/services/api/kimiQuota';
import { pluginsApi } from '@/services/api/plugins';
import type { ManagementTransport, SourceSession } from '@/services/api/sourceSession';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
  type QuotaStore,
} from '@/stores/useQuotaStore';

/** Request dependencies only; provider calculations remain in their existing owners. */
export interface QuotaDependencies {
  apiCallApi: typeof apiCallApi;
  authFilesApi: ReturnType<typeof createAuthFilesApi>;
  management: ManagementTransport;
  guardConfigConnection: () => () => void;
  captureCurrent: (name: string) => () => boolean;
  generation: (name: string) => { session: number; file: number };
  revision: () => number;
  loadPlugins: typeof pluginsApi.list;
  antigravitySubscriptionApi: Pick<typeof antigravitySubscriptionApi, 'get'>;
  resolveKimiQuotaUrl: (file: AuthFileItem) => Promise<string>;
}

/** Only the compatibility facade uses ambient management state. */
export const legacyQuotaDependencies: QuotaDependencies = {
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
  resolveKimiQuotaUrl,
};

export function createQuotaDependencies(
  session: SourceSession,
  store?: QuotaStore
): QuotaDependencies {
  const api = createApiCallApi(session);
  const files = createAuthFilesApi(session);
  const assertCurrent = () => session.assertCurrent();
  // Guard both sides of non-transport awaits too (notably Blob.text()).
  const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const result = await read();
    assertCurrent();
    return result;
  };
  const scopedFiles = {
    ...files,
    downloadText: (name: string) => guarded(() => files.downloadText(name)),
    resetCooldown: (authIndex: string) => guarded(() => files.resetCooldown(authIndex)),
  };
  return {
    apiCallApi: api,
    authFilesApi: scopedFiles,
    management: session.management,
    guardConfigConnection: () => {
      assertCurrent();
      return assertCurrent;
    },
    captureCurrent: (name) => {
      const captured = store ? captureQuotaCacheGeneration(name, store) : undefined;
      return () => {
        try {
          assertCurrent();
          return !captured || commitIfQuotaCacheCurrent(captured, () => {});
        } catch {
          return false;
        }
      };
    },
    generation: (name) => {
      assertCurrent();
      const state = store?.getState();
      return {
        session: state?.cacheGeneration ?? session.owner.sessionEpoch,
        file: state?.fileGenerations[name] ?? 0,
      };
    },
    revision: () => {
      assertCurrent();
      return session.owner.sourceGeneration;
    },
    loadPlugins: () => guarded(() => pluginsApi.list(session.management)),
    antigravitySubscriptionApi: {
      get: (authIndex) => guarded(() => antigravitySubscriptionApi.get(authIndex, api)),
    },
    resolveKimiQuotaUrl: (file) => guarded(() => resolveKimiQuotaUrl(file, scopedFiles)),
  };
}
