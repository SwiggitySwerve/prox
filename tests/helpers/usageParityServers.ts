// Real loopback HTTP, synthetic SQLite and synthetic keys, all temporary data in tmpfs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageStore } from '../../server/usage/store';
import { openParityReader } from '../../scripts/usage-parity/events';
import { queryAnalytics } from '../../server/usage/analytics';
import { validateAnalyticsQuery } from '../../server/usage/validate';
import { event, rateState, rates, book } from './usageAnalytics';
import { parseRateBook } from '../../server/usage/rates';
import type { AnalyticsResponse } from '../../src/domain/analytics/types';
import type { ParityOptions } from '../../scripts/usage-parity/run';

export function parityServers(
  settings: {
    mutate?: (response: AnalyticsResponse, backend: 'cpamp' | 'prox') => void;
    status?: number;
    delayMs?: number;
    d5?: boolean;
  } = {}
) {
  const directory = mkdtempSync('/dev/shm/prox-parity-http-');
  const end = Date.UTC(2026, 10, 13, 22, 17, 23, 456);
  const path = join(directory, 'usage.sqlite');
  const approved = settings.d5
    ? parseRateBook({
        version: 1,
        models: { ...book.models, 'claude-fable-5-2': rates, 'gpt-6.1-terra': rates },
      })
    : book;
  if (settings.d5) writeFileSync(join(directory, 'rates.json'), JSON.stringify(approved));
  const store = new UsageStore({ events: path, raw: null });
  store.insert(
    Array.from({ length: 8 }, (_, i) => ({
      event: event(i, {
        tsMs: end - 1000 - i,
        ...(settings.d5 && i % 3 !== 0
          ? {
              model: i % 3 === 1 ? 'claude-fable-5-2' : 'gpt-6.1-terra',
              billingModel: i % 3 === 1 ? 'claude-fable-5-2' : 'gpt-6.1-terra',
              requestedModel: i % 3 === 1 ? 'claude-fable-5-2' : 'gpt-6.1-terra',
            }
          : {}),
      }),
      raw: null,
    })),
    0
  );
  const reader = openParityReader(path);
  const keys = { cpamp: 'synthetic-cpamp-key-for-parity', prox: 'synthetic-prox-key-for-parity' };
  for (const name of ['cpamp', 'prox'] as const)
    writeFileSync(join(directory, `${name}.key`), keys[name]);
  const seen: { backend: 'cpamp' | 'prox'; query: ReturnType<typeof validateAnalyticsQuery> }[] =
    [];
  let active = 0,
    maximumActive = 0;
  const create = (backend: 'cpamp' | 'prox') =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (request.headers.get('authorization') !== `Bearer ${keys[backend]}`)
            return new Response('', { status: 401 });
          const q = validateAnalyticsQuery(await request.json());
          seen.push({ backend, query: structuredClone(q) });
          if (settings.delayMs) await Bun.sleep(settings.delayMs);
          if (settings.status)
            return new Response(`sensitive error ${keys.cpamp} ${keys.prox}`, {
              status: settings.status,
            });
          if (backend === 'cpamp' && q.before_id !== undefined) q.before_id -= 1000;
          const result = queryAnalytics(reader, q, rateState(backend === 'prox' ? approved : book));
          if (backend === 'cpamp') {
            result.requests.items.forEach((r) => {
              r.id = String(Number(r.id) + 1000);
            });
            if (result.requests.next_before_id !== null) result.requests.next_before_id += 1000;
          }
          settings.mutate?.(result, backend);
          return Response.json(result);
        } finally {
          active--;
        }
      },
    });
  const cpamp = create('cpamp'),
    prox = create('prox');
  const options: ParityOptions = {
    mode: 'quick',
    level: 'responses',
    fromMs: end - 31 * 86400000,
    toMs: end,
    cpampDb: join(directory, 'not-opened.sqlite'),
    proxDb: path,
    cpampUrl: `http://127.0.0.1:${cpamp.port}/v0/management/monitoring/prox-analytics`,
    proxUrl: `http://127.0.0.1:${prox.port}/v1/analytics`,
    cpampKeyFile: join(directory, 'cpamp.key'),
    proxKeyFile: join(directory, 'prox.key'),
    rateBookFile: join(directory, settings.d5 ? 'rates.json' : 'not-needed.json'),
    output: join(directory, 'report'),
    limit: 2,
    sample: 1,
    gapMs: 0,
    outages: [],
  };
  return {
    options,
    seen,
    keys,
    nowMs: end + 3600000,
    directory,
    get maximumActive() {
      return maximumActive;
    },
    close() {
      cpamp.stop(true);
      prox.stop(true);
      reader.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
