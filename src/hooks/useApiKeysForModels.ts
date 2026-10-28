import { useCallback, useMemo } from 'react';
import { apiKeysApi } from '@/services/api/apiKeys';
import { useAuthStore, useConfigStore } from '@/stores';
import { useOptionalProviderSource } from '@/features/providers/ProviderSourceContext';
import type { ProviderSourceScope } from '@/features/providers/sourceScope';

const normalizeApiKeyList = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];

  input.forEach((item) => {
    const record =
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null;
    const value =
      typeof item === 'string'
        ? item
        : record
          ? (record['api-key'] ?? record['apiKey'] ?? record.key ?? record.Key)
          : '';
    const trimmed = String(value ?? '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    keys.push(trimmed);
  });

  return keys;
};

/**
 * 解析用于 /models 探测的 API 密钥列表:
 * 优先取已缓存配置中的 api-keys,否则回退到 /api-keys 接口,结果按连接缓存。
 */
export function createApiKeysForModelsLoader(
  api: Pick<typeof apiKeysApi, 'list'>,
  configApiKeys: unknown,
  assertCurrent: () => void
) {
  let cached: string[] = [];
  return async ({ force = false }: { force?: boolean } = {}) => {
    assertCurrent();
    if (force) cached = [];
    if (cached.length) return cached;
    const configKeys = normalizeApiKeyList(configApiKeys);
    if (configKeys.length) {
      cached = configKeys;
      return configKeys;
    }
    const list = await api.list();
    assertCurrent();
    cached = normalizeApiKeyList(list);
    return cached;
  };
}

export function useApiKeysForModels(sourceScope?: ProviderSourceScope) {
  const context = useOptionalProviderSource();
  const scope = sourceScope ?? context;
  const store = scope?.configStore ?? useConfigStore;
  const configApiKeys = store((state) => state.config?.apiKeys);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const api = scope?.apiKeysApi ?? apiKeysApi;
  const load = useMemo(
    () =>
      createApiKeysForModelsLoader(api, configApiKeys, () => {
        if (scope) scope.assertCurrent();
        else {
          const current = useAuthStore.getState();
          if (current.apiBase !== apiBase || current.managementKey !== managementKey) {
            throw new Error('Model key connection changed');
          }
        }
      }),
    [api, apiBase, configApiKeys, managementKey, scope]
  );
  return useCallback(
    async (options?: { force?: boolean }) => {
      try {
        return await load(options);
      } catch (error) {
        // Source-owned callers distinguish unavailable keys from a complete empty list.
        if (scope) throw error;
        return [];
      }
    },
    [load, scope]
  );
}
