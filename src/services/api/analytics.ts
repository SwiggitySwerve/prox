import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';
import { apiClient } from './client';

/** Pin the query to the authenticated companion connection. */
export function createAnalyticsApi() {
  const client = apiClient.captureConnection();
  return {
    query: (query: AnalyticsQuery, signal: AbortSignal) =>
      client.post<AnalyticsResponse>('/prox/analytics', query, { signal }),
  };
}
