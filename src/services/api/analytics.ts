import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';
import { apiClient } from './client';

/** Pin the query to the authenticated companion connection. */
export function createAnalyticsApi() {
  const client = apiClient.captureConnection();
  return {
    /** The server answers from a warm snapshot unless the caller asks for a recompute. */
    query: (query: AnalyticsQuery, signal: AbortSignal, fresh = false) =>
      client.post<AnalyticsResponse>('/prox/analytics', query, {
        signal,
        ...(fresh ? { headers: { 'Cache-Control': 'no-cache' } } : {}),
      }),
  };
}
