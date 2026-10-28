/**
 * 配置文件相关 API（/config.yaml）
 */

import { apiClient } from './client';
import type { SourceSession, ManagementTransport } from './sourceSession';

function buildConfigFileApi(client: ManagementTransport) {
  return {
    async fetchConfigYaml(): Promise<string> {
      const response = await client.getRaw('/config.yaml', {
        responseType: 'text',
        headers: { Accept: 'application/yaml, text/yaml, text/plain' },
      });
      const data: unknown = response.data;
      if (typeof data === 'string') return data;
      if (data === undefined || data === null) return '';
      return String(data);
    },

    async saveConfigYaml(content: string): Promise<void> {
      await client.put('/config.yaml', content, {
        headers: {
          'Content-Type': 'application/yaml',
          Accept: 'application/json, text/plain, */*',
        },
      });
    },
  };
}

export function createConfigFileApi(session: SourceSession) {
  return buildConfigFileApi(session.management);
}

export const configFileApi = buildConfigFileApi(apiClient);
