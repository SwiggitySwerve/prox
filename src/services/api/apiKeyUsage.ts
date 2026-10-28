import { apiClient } from './client';
import type { ManagementTransport, SourceSession } from './sourceSession';
import type { ApiKeyUsageResponse } from '@/utils/recentRequests';

const API_KEY_USAGE_TIMEOUT_MS = 15 * 1000;

export function createApiKeyUsageApi(session: SourceSession) {
  return buildApiKeyUsageApi(session.management, () => session.assertCurrent());
}

function buildApiKeyUsageApi(transport: ManagementTransport, assertCurrent: () => void = () => {}) {
  return {
    getUsage: async () => {
      assertCurrent();
      const result = await transport.get<ApiKeyUsageResponse>('/observability/usage/api-keys', {
        timeout: API_KEY_USAGE_TIMEOUT_MS,
      });
      assertCurrent();
      return result;
    },
  };
}

export const apiKeyUsageApi = buildApiKeyUsageApi(apiClient);
