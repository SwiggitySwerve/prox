import type { TFunction } from 'i18next';
import type { DevinQuotaData, DevinQuotaState } from '@/types';
import { isDevinFile, isDisabledAuthFile } from '@/utils/quota';
import type { QuotaProviderData } from '../types';
import { legacyQuotaDependencies, type QuotaDependencies } from '../dependencies';
import { createDevinQuotaFetcher, DevinQuotaError } from './requests';

export function createDevinQuotaConfig(deps: QuotaDependencies = legacyQuotaDependencies) {
  const { apiCallApi } = deps;

  const fetchSnapshot = createDevinQuotaFetcher({
    request: (payload) => apiCallApi.request(payload),
    generation: deps.generation,
  });

  const withLabels = (quota: DevinQuotaData, t: TFunction): DevinQuotaData => ({
    ...quota,
    windows: quota.windows.map((window) => ({
      ...window,
      label: t(`devin_quota.${window.id}`),
    })),
  });

  const emptyData = (): DevinQuotaData => ({
    windows: [],
    observedAtMs: null,
    plan: null,
    planStartMs: null,
    planEndMs: null,
  });

  const config: QuotaProviderData<DevinQuotaState, DevinQuotaData> = {
    type: 'devin',
    i18nPrefix: 'devin_quota',
    filterFn: (file) => isDevinFile(file) && !isDisabledAuthFile(file),
    fetchQuota: async (file, t) => {
      try {
        return withLabels(await fetchSnapshot(file), t);
      } catch (error: unknown) {
        if (error instanceof DevinQuotaError) {
          error.message = t(`devin_quota.${error.code}`);
        }
        throw error;
      }
    },
    storeSelector: (state) => state.devinQuota,
    storeSetter: 'setDevinQuota',
    buildLoadingState: () => ({ status: 'loading', ...emptyData() }),
    buildSuccessState: (data) => ({ status: 'success', ...data }),
    buildErrorState: (error, errorStatus) => ({
      status: 'error',
      ...emptyData(),
      error,
      errorStatus,
    }),
  };

  return config;
}

export const DEVIN_CONFIG = createDevinQuotaConfig();
