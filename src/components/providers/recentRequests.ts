import type { apiKeyUsageApi } from '@/services/api/apiKeyUsage';
import {
  normalizeRecentRequestUsageEntry,
  type ApiKeyUsageResponse,
  type RecentRequestUsageEntry,
} from '@/utils/recentRequests';
export const PROVIDER_RECENT_REQUESTS_STALE_TIME_MS = 240_000;

export type ProviderRecentRequests = Map<string, Map<string, RecentRequestUsageEntry>>;

export const EMPTY_USAGE_BY_PROVIDER: ProviderRecentRequests = new Map();

type ProviderRecentRequestsCache = {
  cachedUsageByProvider: ProviderRecentRequests;
  cachedAt: number;
  inFlightRequest: Promise<ProviderRecentRequests> | null;
};

export const createProviderRecentRequestsCache = (): ProviderRecentRequestsCache => ({
  cachedUsageByProvider: EMPTY_USAGE_BY_PROVIDER,
  cachedAt: 0,
  inFlightRequest: null,
});

export const createProviderRecentRequestsCacheController = () => {
  let currentApiBase = '';
  let currentManagementKey = '';
  let currentCache = createProviderRecentRequestsCache();

  return {
    forScope(apiBase: string, managementKey: string): ProviderRecentRequestsCache {
      if (apiBase !== currentApiBase || managementKey !== currentManagementKey) {
        currentApiBase = apiBase;
        currentManagementKey = managementKey;
        currentCache = createProviderRecentRequestsCache();
      }
      return currentCache;
    },
  };
};

const normalizeProviderKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const normalizeApiKeyUsageResponse = (payload: ApiKeyUsageResponse): ProviderRecentRequests => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return EMPTY_USAGE_BY_PROVIDER;
  }

  const usageByProvider: ProviderRecentRequests = new Map();

  Object.entries(payload).forEach(([provider, entries]) => {
    const providerKey = normalizeProviderKey(provider);
    if (!providerKey || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      return;
    }

    const usageByCompositeKey = new Map<string, RecentRequestUsageEntry>();
    Object.entries(entries).forEach(([compositeKey, entry]) => {
      usageByCompositeKey.set(compositeKey, normalizeRecentRequestUsageEntry(entry));
    });

    usageByProvider.set(providerKey, usageByCompositeKey);
  });

  return usageByProvider;
};

export const fetchProviderRecentRequests = async (
  cache: ProviderRecentRequestsCache,
  api: Pick<typeof apiKeyUsageApi, 'getUsage'>
): Promise<ProviderRecentRequests> => {
  if (!cache.inFlightRequest) {
    const request = api
      .getUsage()
      .then((payload) => {
        if (cache.inFlightRequest !== request) return cache.cachedUsageByProvider;
        const normalized = normalizeApiKeyUsageResponse(payload);
        cache.cachedUsageByProvider = normalized;
        cache.cachedAt = Date.now();
        return normalized;
      })
      .finally(() => {
        if (cache.inFlightRequest === request) {
          cache.inFlightRequest = null;
        }
      });
    cache.inFlightRequest = request;
  }

  return cache.inFlightRequest;
};
