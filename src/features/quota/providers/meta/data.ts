import type { TFunction } from 'i18next';
import type { MetaQuotaData, MetaQuotaState } from '@/types';
import type { QuotaProviderData } from '../types';
import { isMetaQuotaFile } from '../filters';
import type { QuotaDependencies } from '../dependencies';
import { createMetaQuotaFetcher, MetaQuotaError } from './requests';

export function createMetaQuotaConfig(deps: QuotaDependencies) {
  const { apiCallApi, authFilesApi } = deps;

  const fetchMetaQuota = createMetaQuotaFetcher({
    request: (payload) => apiCallApi.request(payload),
    downloadText: (name) => authFilesApi.downloadText(name),
    captureCurrent: deps.captureCurrent,
  });

  const config: QuotaProviderData<MetaQuotaState, MetaQuotaData> = {
    type: 'meta',
    i18nPrefix: 'meta_quota',
    filterFn: isMetaQuotaFile,
    fetchQuota: async (file, t: TFunction) => {
      try {
        return await fetchMetaQuota(file);
      } catch (error: unknown) {
        if (error instanceof MetaQuotaError) {
          error.message = t(`meta_quota.${error.code}`, { status: error.status });
        }
        throw error;
      }
    },
    storeSelector: (state) => state.metaQuota,
    storeSetter: 'setMetaQuota',
    buildLoadingState: () => ({ status: 'loading' }),
    buildSuccessState: (data) => ({ status: 'success', data }),
    buildErrorState: (error, errorStatus) => ({
      status: 'error',
      error,
      errorStatus,
    }),
  };

  return config;
}
