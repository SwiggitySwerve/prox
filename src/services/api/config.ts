/**
 * 配置相关 API
 */

import { apiClient } from './client';
import type { ManagementTransport, SourceSession } from './sourceSession';
import type { Config } from '@/types';
import { normalizeConfigResponse } from './transformers';
import { validateProviderInventory } from './providerInventory';

export function createConfigApi(session: SourceSession) {
  return buildConfigApi(
    session.management,
    () => session.assertCurrent(),
    validateProviderInventory
  );
}

function buildConfigApi(
  transport: ManagementTransport,
  assertCurrent: () => void = () => {},
  validate: (raw: unknown) => void = () => {}
) {
  return {
    /**
     * 获取配置（会进行字段规范化）
     */
    async getConfig(): Promise<Config> {
      assertCurrent();
      const raw = await transport.get('/config');
      assertCurrent();
      validate(raw);
      return normalizeConfigResponse(raw);
    },

    /**
     * 请求日志开关
     */
    updateRequestLog: async (enabled: boolean) => {
      assertCurrent();
      const result = await transport.put('/config/observability/logs/request-log', enabled);
      assertCurrent();
      return result;
    },
  };
}

export const configApi = buildConfigApi(apiClient);
