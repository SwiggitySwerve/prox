import { readFile } from 'node:fs/promises';
import { authorized } from '../app';
import { readJson } from '../http/readJson';
import { isRecord } from '../../src/utils/helpers';
import type { SourceManifest } from '../../src/domain/providerSources/types';
import { readCatalogs, type Fetcher } from './catalog';

const QUERY_FIELDS = new Set([
  'from_ms',
  'to_ms',
  'time_zone',
  'granularity',
  'provider',
  'model',
  'outcome',
  'search',
  'limit',
  'before_ms',
  'before_id',
]);

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** Fixed authenticated bridge. CPA owns query validation, accounting and safe projections. */
export function createAnalyticsHandler(
  manifest: SourceManifest,
  fetcher: Fetcher = fetch,
  readKey = async (path: string) => (await readFile(path, 'utf8')).trim()
) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!authorized(request, manifest.history.managementKeyFile))
        return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Management authentication unavailable' }, 503);
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const config = manifest.analytics;
    if (!config) return json({ error: 'Analytics is not configured for this deployment' }, 503);
    let query: Record<string, unknown>;
    try {
      if (!request.body) throw new Error('Missing query');
      const body = await readJson(request.body, 16 * 1024);
      if (!isRecord(body) || Object.keys(body).some((key) => !QUERY_FIELDS.has(key)))
        throw new Error('Invalid query');
      query = body;
    } catch {
      return json({ error: 'Invalid analytics query' }, 400);
    }
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
      const { catalog, catalog_sources } = await readCatalogs(
        manifest.sources,
        signal,
        fetcher,
        readKey
      );
      const key = await readKey(config.adminKeyFile);
      if (!key) throw new Error('Missing dataset credential');
      signal.throwIfAborted();
      const response = await fetcher(
        new URL('/v0/management/monitoring/prox-analytics', config.upstreamOrigin),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...query, catalog }),
          signal,
          redirect: 'error',
        }
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return json(
          {
            error:
              response.status === 400
                ? 'Invalid analytics filters'
                : 'Analytics data is temporarily unavailable',
          },
          response.status === 400 ? 400 : 503
        );
      }
      const result = await readJson(response.body, 32 * 1024 * 1024);
      if (
        !isRecord(result) ||
        result.schema_version !== 1 ||
        !isRecord(result.summary) ||
        !isRecord(result.coverage) ||
        !isRecord(result.requests) ||
        !Array.isArray(result.rates) ||
        !Array.isArray(result.timeline)
      )
        throw new Error('Invalid analytics response');
      return json({ ...result, catalog_sources });
    } catch {
      return json({ error: 'Analytics data is temporarily unavailable' }, 503);
    }
  };
}
