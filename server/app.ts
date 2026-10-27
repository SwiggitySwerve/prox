import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildDashboard } from './quota/domain';
import type { CollectionState, DashboardOptions } from './quota/domain';
import type { QuotaStore } from './quota/store';
import { DAY_MS, HOUR_MS } from './quota/types';

interface CollectorState extends Omit<CollectionState, 'historyStartedAtMs'> {
  refresh(): Promise<void>;
}
export interface AppDependencies {
  store: QuotaStore;
  collector: CollectorState;
  keyFile: string;
  now?: () => number;
}

export function parseOptions(params: URLSearchParams, nowMs: number): DashboardOptions {
  const choices = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const values = params.getAll(name);
    const value = values[0] ?? fallback;
    if (values.length > 1 || !allowed.includes(value as T)) throw new Error(`Invalid ${name}`);
    return value as T;
  };
  const offset = params.getAll('offsetDays');
  if (offset.length > 1 || !/^-?\d{1,2}$/.test(offset[0] ?? '0'))
    throw new Error('Invalid offsetDays');
  const offsetDays = Number(offset[0] ?? 0);
  if (offsetDays < -14 || offsetDays > 14) throw new Error('Invalid offsetDays');
  return {
    nowMs,
    window: choices('window', ['weekly', 'five-hour'], 'weekly'),
    lookbackHours: Number(choices('lookback', ['1', '3', '6'], '3')) as 1 | 3 | 6,
    multiplier: Number(choices('multiplier', ['0', '0.5', '1', '2'], '1')) as 0 | 0.5 | 1 | 2,
    offsetDays,
    reveal: choices('reveal', ['true', 'false'], 'false') === 'true',
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function authorized(request: Request, keyFile: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 4096) return false;
  const key = readFileSync(keyFile, 'utf8').trim();
  if (!key) throw new Error('Management key unavailable');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(key), digest(header.slice(7)));
}

export function createHandler({ store, collector, keyFile, now = Date.now }: AppDependencies) {
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return new Response('ok\n');
    try {
      if (!authorized(request, keyFile)) return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Management authentication unavailable' }, 503);
    }
    if (url.pathname === '/v1/refresh' && request.method === 'POST') {
      // Collection owns single-flight behavior, rate limits and sanitized failures.
      void collector.refresh().catch(() => console.error('Quota collection failed'));
      return json(
        {
          refreshing: collector.refreshing,
          lastRefreshAtMs: collector.lastRefreshAtMs,
          nextRefreshAtMs: collector.nextRefreshAtMs,
        },
        202
      );
    }
    if (url.pathname !== '/v1/pools' || request.method !== 'GET')
      return json({ error: 'Not found' }, 404);
    let options: DashboardOptions;
    try {
      options = parseOptions(url.searchParams, now());
    } catch {
      return json({ error: 'Invalid dashboard filters' }, 400);
    }
    try {
      const fromMs = Math.min(
        options.nowMs - 6 * HOUR_MS,
        Math.floor(options.nowMs / DAY_MS) * DAY_MS +
          (options.offsetDays - 3) * DAY_MS -
          6 * HOUR_MS
      );
      return json(
        buildDashboard(
          store.listAccounts(),
          store.listSamples(fromMs, options.nowMs, options.window),
          options,
          {
            historyStartedAtMs: store.firstSampleAtMs(),
            lastRefreshAtMs: collector.lastRefreshAtMs,
            nextRefreshAtMs: collector.nextRefreshAtMs,
            refreshing: collector.refreshing,
            issues: collector.issues,
            sources: collector.sources,
          }
        )
      );
    } catch {
      console.error('Quota dashboard read failed');
      return json({ error: 'Quota history is temporarily unavailable' }, 503);
    }
  };
}
