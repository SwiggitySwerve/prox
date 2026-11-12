import { readFile } from 'node:fs/promises';
import { authorized } from '../app';
import { readJson } from '../http/readJson';
import { isRecord } from '../../src/utils/helpers';
import type { SourceManifest } from '../../src/domain/providerSources/types';
import { rangeQuery, ranges } from '../../src/features/analytics/queryState';
import { readCatalogs, type Fetcher } from './catalog';
import { createSnapshotCache, type Outcome, type Query } from './cache';

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
  readKey = async (path: string) => (await readFile(path, 'utf8')).trim(),
  clock: () => number = Date.now
) {
  const config = manifest.analytics;
  async function compute(query: Query): Promise<Outcome> {
    if (!config) return { ok: false, status: 503 };
    try {
      // Not tied to the caller's connection: the result is shared with later requests.
      const signal = AbortSignal.timeout(30000);
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
        return { ok: false, status: response.status === 400 ? 400 : 503 };
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
      return { ok: true, body: { ...result, catalog_sources } };
    } catch {
      return { ok: false, status: 503 };
    }
  }
  const cache = createSnapshotCache(compute, clock, defaultViews);
  const handler = async (request: Request): Promise<Response> => {
    try {
      if (!authorized(request, manifest.history.managementKeyFile))
        return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Management authentication unavailable' }, 503);
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!config) return json({ error: 'Analytics is not configured for this deployment' }, 503);
    let query: Query;
    try {
      if (!request.body) throw new Error('Missing query');
      const body = await readJson(request.body, 16 * 1024);
      if (!isRecord(body) || Object.keys(body).some((key) => !QUERY_FIELDS.has(key)))
        throw new Error('Invalid query');
      query = body;
    } catch {
      return json({ error: 'Invalid analytics query' }, 400);
    }
    // Refresh asks for a recompute; every other load takes the warm snapshot.
    const fresh = request.headers.get('cache-control')?.includes('no-cache') ?? false;
    const outcome = await cache.get(query, fresh);
    if (outcome.ok) return json(outcome.body);
    return json(
      {
        error:
          outcome.status === 400
            ? 'Invalid analytics filters'
            : 'Analytics data is temporarily unavailable',
      },
      outcome.status
    );
  };
  return Object.assign(handler, { warm: () => cache.warm() });
}

/** The views the page opens by default, so the first visit of the day is already warm. */
function defaultViews(now: number): Query[] {
  return [
    ...ranges.map((range) => ({ ...rangeQuery(range, now) })),
    // The hourly spreads of the longer ranges are the heaviest views people ask for.
    { ...rangeQuery('7d', now, 'hour') },
    { ...rangeQuery('30d', now, 'hour') },
  ];
}
