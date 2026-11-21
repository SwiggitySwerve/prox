/**
 * Kimi 额度数据层。React-free / SCSS-free。
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, KimiQuotaState } from '@/types';
import { getApiCallErrorMessage } from '@/services/api/apiCall';
import { fetchKimiPlanName } from '@/services/api/kimiQuota';
import {
  KIMI_REQUEST_HEADERS,
  parseKimiUsagePayload,
  buildKimiQuotaRows,
  createStatusError,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '../types';
import { isKimiQuotaFile } from '../filters';
import type { QuotaDependencies } from '../dependencies';

type KimiQuotaData = Pick<KimiQuotaState, 'rows' | 'planName'>;

export function createKimiQuotaConfig(deps: QuotaDependencies) {
  const { apiCallApi, resolveKimiQuotaUrl } = deps;

  const fetchKimiQuota = async (file: AuthFileItem, t: TFunction): Promise<KimiQuotaData> => {
    const rawAuthIndex = file['auth_index'] ?? file.authIndex;
    const authIndex = normalizeAuthIndex(rawAuthIndex);
    if (!authIndex) {
      throw new Error(t('kimi_quota.missing_auth_index'));
    }

    const isCurrent = deps.captureCurrent(file.name);
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new Error(t('kimi_quota.stale_request'));
      }
    };
    let url: string;
    try {
      url = await resolveKimiQuotaUrl(file);
    } catch {
      assertCurrent();
      throw new Error(t('kimi_quota.domain_unavailable'));
    }
    assertCurrent();

    const result = await apiCallApi.request({
      authIndex,
      method: 'GET',
      url,
      header: { ...KIMI_REQUEST_HEADERS },
    });
    assertCurrent();

    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
    }

    const payload = parseKimiUsagePayload(result.body ?? result.bodyText);
    if (!payload) {
      throw new Error(t('kimi_quota.empty_data'));
    }

    const planName = await fetchKimiPlanName(authIndex, url, apiCallApi);
    // Profile failures are optional, but session/file invalidation must still reject the result.
    assertCurrent();
    return { rows: buildKimiQuotaRows(payload), planName };
  };

  const config: QuotaProviderData<KimiQuotaState, KimiQuotaData> = {
    type: 'kimi',
    i18nPrefix: 'kimi_quota',
    filterFn: isKimiQuotaFile,
    fetchQuota: fetchKimiQuota,
    storeSelector: (state) => state.kimiQuota,
    storeSetter: 'setKimiQuota',
    buildLoadingState: () => ({ status: 'loading', rows: [] }),
    buildSuccessState: (data) => ({ status: 'success', ...data }),
    buildErrorState: (message, status) => ({
      status: 'error',
      rows: [],
      error: message,
      errorStatus: status,
    }),
  };

  return config;
}
