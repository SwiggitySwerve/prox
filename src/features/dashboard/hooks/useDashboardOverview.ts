import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAnalyticsApi } from '@/services/api/analytics';
import { apiClient } from '@/services/api/client';
import { createAuthFilesApi } from '@/services/api/authFiles';
import { useProviderSource } from '@/features/providers/ProviderSourceContext';
import { useAuthStore } from '@/stores';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import { useProviderRecentRequests } from '@/components/providers/hooks/useProviderRecentRequests';
import { PROVIDER_RECENT_REQUESTS_STALE_TIME_MS } from '@/components/providers/recentRequests';
import { useInterval } from '@/hooks/useInterval';
import {
  mergeRecentRequestBucketGroups,
  normalizeRecentRequestUsageEntry,
  type RecentRequestBucket,
} from '@/utils/recentRequests';
import type { AnalyticsResponse } from '@/domain/analytics/types';
import type { Config } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import { analyticsUsable, analyticsWindow, trafficFromAnalytics } from '../analyticsTraffic';
import {
  TRAFFIC_BUCKET_MINUTES,
  type CredentialHealth,
  type DashboardCounts,
  type ProviderTraffic,
  type TrafficWindow,
} from '../types';

const EMPTY_TRAFFIC: TrafficWindow = {
  buckets: [],
  totalSuccess: 0,
  totalFailure: 0,
  total: 0,
  successRate: null,
  peakTotal: 0,
  peakIndex: -1,
  windowMinutes: 0,
  bucketMinutes: TRAFFIC_BUCKET_MINUTES,
};

/** `api-key-usage` 的键形如 `<baseUrl>|<apiKey>`，取第一个分隔符之后的部分 */
const apiKeyFromCompositeKey = (compositeKey: string): string => {
  const separatorIndex = compositeKey.indexOf('|');
  return separatorIndex < 0 ? '' : compositeKey.slice(separatorIndex + 1).trim();
};

const providerIdOfAuthFile = (file: AuthFileItem): string => {
  const candidate = String(file.type ?? file.provider ?? '')
    .trim()
    .toLowerCase();
  return candidate && candidate !== 'empty' ? candidate : 'unknown';
};

const buildTrafficWindow = (bucketGroups: RecentRequestBucket[][]): TrafficWindow => {
  const buckets = mergeRecentRequestBucketGroups(bucketGroups);
  if (buckets.length === 0) {
    return EMPTY_TRAFFIC;
  }

  let totalSuccess = 0;
  let totalFailure = 0;
  let peakTotal = 0;
  let peakIndex = -1;

  buckets.forEach((bucket, index) => {
    const bucketTotal = bucket.success + bucket.failed;
    totalSuccess += bucket.success;
    totalFailure += bucket.failed;
    if (bucketTotal > peakTotal) {
      peakTotal = bucketTotal;
      peakIndex = index;
    }
  });

  const total = totalSuccess + totalFailure;

  return {
    buckets,
    totalSuccess,
    totalFailure,
    total,
    successRate: total > 0 ? (totalSuccess / total) * 100 : null,
    peakTotal,
    peakIndex,
    windowMinutes: buckets.length * TRAFFIC_BUCKET_MINUTES,
    bucketMinutes: TRAFFIC_BUCKET_MINUTES,
  };
};

interface ProviderAccumulator {
  credentials: number;
  success: number;
  failure: number;
  bucketGroups: RecentRequestBucket[][];
}

const createAccumulator = (): ProviderAccumulator => ({
  credentials: 0,
  success: 0,
  failure: 0,
  bucketGroups: [],
});

export const getProviderKeyCounts = (config: Config) => ({
  gemini: config.geminiApiKeys?.length ?? 0,
  interactions: config.interactionsApiKeys?.length ?? 0,
  codex: config.codexApiKeys?.length ?? 0,
  meta: config.metaApiKeys?.length ?? 0,
  xai: config.xaiApiKeys?.length ?? 0,
  claude: config.claudeApiKeys?.length ?? 0,
  vertex: config.vertexApiKeys?.length ?? 0,
  openai: config.openaiCompatibility?.length ?? 0,
});

/**
 * 汇总仪表盘所需的全部数据。
 *
 * 流量数据有两个互不重叠的来源：`api-key-usage`（配置内联的 API Key 凭证）
 * 与 `auth-files`（文件/运行时凭证）。后端对二者的判定条件互斥，但插件提供的
 * 凭证理论上可同时命中，因此这里按 `account_type` + `account` 做一次防御性去重。
 *
 * 这两个来源只是内存中的最近计数（约 200 分钟的桶 + 进程重启即清零的累计值），
 * 所以只要分析数据（保留的用量事件）对本来源的每个供应商都完整可用，
 * 流量与供应商数字就改用最近 24 小时的分析数据；否则退回上述计数。
 */
export function useDashboardOverview() {
  const scope = useProviderSource();
  const useConfigStore = scope.configStore;
  const useModelsStore = scope.modelsStore;
  const authFilesApi = useMemo(() => createAuthFilesApi(scope.session), [scope.session]);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = scope.source.apiBase;
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);

  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const modelsError = useModelsStore((state) => state.error);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const connected = connectionStatus === 'connected';
  const resolveApiKeysForModels = useApiKeysForModels();

  const { usageByProvider, refreshRecentRequests } = useProviderRecentRequests({
    enabled: connected,
  });

  const [authFiles, setAuthFiles] = useState<AuthFileItem[] | null>(null);

  const loadAuthFiles = useCallback(async () => {
    if (!connected) return;
    try {
      const response = await authFilesApi.list();
      scope.assertCurrent();
      setAuthFiles(response.files);
    } catch {
      setAuthFiles(null);
    }
  }, [connected, authFilesApi, scope]);

  const loadModels = useCallback(async () => {
    if (!connected || !apiBase) return;
    try {
      const apiKeys = await resolveApiKeysForModels();
      await fetchModelsFromStore(apiBase, apiKeys[0]);
    } catch {
      // 模型列表失败不应影响仪表盘其余部分
    }
  }, [connected, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  useEffect(() => {
    if (!connected) return;
    void fetchConfig().catch(() => undefined);
    void loadAuthFiles();
    void loadModels();
  }, [connected, fetchConfig, loadAuthFiles, loadModels]);

  // Analytics answers per provider (it has no instance filter); this source's providers are
  // the ones its own credentials and API keys belong to.
  const analyticsKey = useMemo(() => {
    const ids = new Set(usageByProvider.keys());
    (authFiles ?? []).forEach((file) => ids.add(providerIdOfAuthFile(file)));
    return ids.has('unknown') ? '' : [...ids].sort().join(',');
  }, [usageByProvider, authFiles]);
  const [analytics, setAnalytics] = useState<{
    key: string;
    window: ReturnType<typeof analyticsWindow>;
    responses: Map<string, AnalyticsResponse>;
  } | null>(null);
  const analyticsController = useRef<AbortController | undefined>(undefined);

  const loadAnalytics = useCallback(async () => {
    if (!connected || !analyticsKey) return;
    analyticsController.current?.abort();
    const controller = new AbortController();
    analyticsController.current = controller;
    const revision = apiClient.getConnectionRevision();
    const window = analyticsWindow(Date.now());
    const api = createAnalyticsApi();
    try {
      const entries = await Promise.all(
        analyticsKey.split(',').map(async (provider) => {
          const response = await api.query(
            {
              ...window,
              time_zone: 'UTC',
              granularity: 'hour',
              provider,
              outcome: 'all',
              limit: 1,
            },
            controller.signal
          );
          return [provider, response] as const;
        })
      );
      scope.assertCurrent();
      if (controller.signal.aborted || apiClient.getConnectionRevision() !== revision) return;
      setAnalytics({ key: analyticsKey, window, responses: new Map(entries) });
    } catch {
      // Unsupported or unavailable analytics must not hide the counters below.
      if (!controller.signal.aborted) setAnalytics(null);
    }
  }, [connected, analyticsKey, scope]);

  useEffect(() => {
    void loadAnalytics();
    return () => analyticsController.current?.abort();
  }, [loadAnalytics]);

  // The counters poll on this cadence; without it the analytics numbers (and window) would
  // freeze until a manual refresh, because the provider set rarely changes.
  useInterval(
    () => {
      void loadAnalytics();
    },
    connected && analyticsKey ? PROVIDER_RECENT_REQUESTS_STALE_TIME_MS : null
  );

  const refresh = useCallback(async () => {
    if (!connected) return;
    await Promise.allSettled([
      fetchConfig(true),
      loadAuthFiles(),
      loadModels(),
      refreshRecentRequests(),
      loadAnalytics(),
    ]);
  }, [connected, fetchConfig, loadAuthFiles, loadModels, refreshRecentRequests, loadAnalytics]);

  const providerKeyCounts = useMemo(() => (config ? getProviderKeyCounts(config) : null), [config]);

  const recent = useMemo(() => {
    const accumulators = new Map<string, ProviderAccumulator>();
    const allBucketGroups: RecentRequestBucket[][] = [];
    const apiKeysFromUsage = new Set<string>();

    const accumulatorFor = (providerId: string): ProviderAccumulator => {
      const existing = accumulators.get(providerId);
      if (existing) return existing;
      const created = createAccumulator();
      accumulators.set(providerId, created);
      return created;
    };

    usageByProvider.forEach((entriesByKey, providerId) => {
      const accumulator = accumulatorFor(providerId);
      entriesByKey.forEach((entry, compositeKey) => {
        const apiKey = apiKeyFromCompositeKey(compositeKey);
        if (apiKey) {
          apiKeysFromUsage.add(apiKey);
        }
        accumulator.credentials += 1;
        accumulator.success += entry.success;
        accumulator.failure += entry.failed;
        if (entry.recentRequests.length > 0) {
          accumulator.bucketGroups.push(entry.recentRequests);
          allBucketGroups.push(entry.recentRequests);
        }
      });
    });

    (authFiles ?? []).forEach((file) => {
      const accountType = String(file.account_type ?? '')
        .trim()
        .toLowerCase();
      const account = String(file.account ?? '').trim();
      // 已经由 api-key-usage 统计过的凭证不再重复计入
      if (accountType === 'api_key' && account && apiKeysFromUsage.has(account)) {
        return;
      }

      const accumulator = accumulatorFor(providerIdOfAuthFile(file));
      const entry = normalizeRecentRequestUsageEntry(file);
      accumulator.credentials += 1;
      accumulator.success += entry.success;
      accumulator.failure += entry.failed;
      if (entry.recentRequests.length > 0) {
        accumulator.bucketGroups.push(entry.recentRequests);
        allBucketGroups.push(entry.recentRequests);
      }
    });

    const providerRows: ProviderTraffic[] = Array.from(accumulators.entries())
      .map(([id, accumulator]) => {
        const total = accumulator.success + accumulator.failure;
        return {
          id,
          credentials: accumulator.credentials,
          success: accumulator.success,
          failure: accumulator.failure,
          total,
          successRate: total > 0 ? (accumulator.success / total) * 100 : null,
          buckets: mergeRecentRequestBucketGroups(accumulator.bucketGroups),
        };
      })
      .sort(
        (a, b) => b.total - a.total || b.credentials - a.credentials || a.id.localeCompare(b.id)
      );

    return {
      traffic: buildTrafficWindow(allBucketGroups),
      providers: providerRows,
    };
  }, [usageByProvider, authFiles]);

  const fromAnalytics = useMemo(
    () =>
      analytics?.key === analyticsKey &&
      analyticsUsable(analyticsKey.split(','), analytics.responses)
        ? trafficFromAnalytics(analytics.window, analytics.responses)
        : null,
    [analytics, analyticsKey]
  );
  const traffic = fromAnalytics?.traffic ?? recent.traffic;
  const providers = useMemo(
    () =>
      fromAnalytics
        ? recent.providers
            .map((row) => ({ ...row, ...fromAnalytics.providers.get(row.id) }))
            .sort(
              (a, b) =>
                b.total - a.total || b.credentials - a.credentials || a.id.localeCompare(b.id)
            )
        : recent.providers,
    [fromAnalytics, recent.providers]
  );

  const credentials = useMemo<CredentialHealth | null>(() => {
    if (!authFiles) return null;

    let disabled = 0;
    let unavailable = 0;
    const countsByType = new Map<string, number>();

    authFiles.forEach((file) => {
      if (file.disabled) {
        disabled += 1;
      } else if (file.unavailable) {
        unavailable += 1;
      }
      const type = providerIdOfAuthFile(file);
      countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
    });

    return {
      total: authFiles.length,
      active: authFiles.length - disabled - unavailable,
      disabled,
      unavailable,
      byType: Array.from(countsByType.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    };
  }, [authFiles]);

  const counts = useMemo<DashboardCounts>(
    () => ({
      managementKeys: config ? (config.apiKeys?.length ?? 0) : null,
      providerKeys: providerKeyCounts
        ? Object.values(providerKeyCounts).reduce((sum, count) => sum + count, 0)
        : null,
      credentials: authFiles ? authFiles.length : null,
      models: modelsLoading || modelsError ? null : models.length,
    }),
    [config, providerKeyCounts, authFiles, models.length, modelsLoading, modelsError]
  );

  return {
    connectionStatus,
    connected,
    config,
    counts,
    providerKeyCounts,
    traffic,
    providers,
    credentials,
    refresh,
  };
}
