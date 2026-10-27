import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { apiKeyUsageApi } from '@/services/api/apiKeyUsage';
import { useAuthStore } from '@/stores/useAuthStore';
import { useOptionalProviderSource } from '@/features/providers/ProviderSourceContext';
import type { ProviderSourceScope } from '@/features/providers/sourceScope';
import {
  createProviderRecentRequestsCacheController,
  EMPTY_USAGE_BY_PROVIDER,
  fetchProviderRecentRequests,
  PROVIDER_RECENT_REQUESTS_STALE_TIME_MS,
  type ProviderRecentRequests,
} from '../recentRequests';
export {
  createProviderRecentRequestsCacheController,
  type ProviderRecentRequests,
} from '../recentRequests';
export type UseProviderRecentRequestsOptions = { enabled?: boolean; scope?: ProviderSourceScope };
const providerRecentRequestsCacheController = createProviderRecentRequestsCacheController();

export function useProviderRecentRequests(options: UseProviderRecentRequestsOptions = {}) {
  const context = useOptionalProviderSource();
  const scope = options.scope ?? context;
  const api = scope?.apiKeyUsageApi ?? apiKeyUsageApi;
  const enabled = options.enabled ?? true;
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const cache = useMemo(
    () =>
      scope?.recentRequestsCache ??
      providerRecentRequestsCacheController.forScope(apiBase, managementKey),
    [scope, apiBase, managementKey]
  );
  const [usageState, setUsageState] = useState(() => ({
    cache,
    value: cache.cachedUsageByProvider,
  }));
  const [loadingState, setLoadingState] = useState(() => ({ cache, value: false }));

  const setUsageForCurrentScope = useCallback(
    (value: ProviderRecentRequests) => setUsageState({ cache, value }),
    [cache]
  );

  const setLoadingForCurrentScope = useCallback(
    (value: boolean) => setLoadingState({ cache, value }),
    [cache]
  );

  const loadRecentRequests = useCallback(
    async (loadOptions: { force?: boolean } = {}) => {
      const revision = scope?.getRevision();
      const current = () => !scope || (scope.isCurrent() && scope.getRevision() === revision);
      if (!enabled || !current()) {
        return EMPTY_USAGE_BY_PROVIDER;
      }

      const hasFreshCache =
        cache.cachedAt > 0 && Date.now() - cache.cachedAt < PROVIDER_RECENT_REQUESTS_STALE_TIME_MS;

      if (!loadOptions.force && hasFreshCache) {
        setUsageForCurrentScope(cache.cachedUsageByProvider);
        return cache.cachedUsageByProvider;
      }

      setLoadingForCurrentScope(true);
      try {
        const nextUsage = await fetchProviderRecentRequests(cache, api);
        if (current()) setUsageForCurrentScope(nextUsage);
        return nextUsage;
      } catch {
        if (current() && cache.cachedAt > 0) {
          setUsageForCurrentScope(cache.cachedUsageByProvider);
        }
        return cache.cachedUsageByProvider;
      } finally {
        if (current()) setLoadingForCurrentScope(false);
      }
    },
    [api, cache, enabled, scope, setLoadingForCurrentScope, setUsageForCurrentScope]
  );

  const refreshRecentRequests = useCallback(
    async () => loadRecentRequests({ force: true }),
    [loadRecentRequests]
  );

  useEffect(() => {
    if (!enabled) {
      setUsageForCurrentScope(EMPTY_USAGE_BY_PROVIDER);
      return;
    }
    void loadRecentRequests().catch(() => {});
  }, [enabled, loadRecentRequests, setUsageForCurrentScope]);

  useInterval(
    () => {
      void refreshRecentRequests().catch(() => {});
    },
    enabled ? PROVIDER_RECENT_REQUESTS_STALE_TIME_MS : null
  );

  const usageByProvider =
    usageState.cache === cache ? usageState.value : cache.cachedUsageByProvider;
  const isLoading =
    loadingState.cache === cache ? loadingState.value : cache.inFlightRequest !== null;

  return {
    usageByProvider: enabled ? usageByProvider : EMPTY_USAGE_BY_PROVIDER,
    isLoading: enabled ? isLoading : false,
    loadRecentRequests,
    refreshRecentRequests,
  };
}
