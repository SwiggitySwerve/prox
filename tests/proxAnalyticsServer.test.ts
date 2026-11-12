import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyticsHandler } from '../server/analytics/handler';
import { dashboardAnalyticsQuery } from '../src/features/dashboard/analyticsTraffic';
import {
  validateSourceManifest,
  publicSourceDiscovery,
} from '../src/domain/providerSources/manifest';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prox-analytics-'));
  const keyFile = join(directory, 'key');
  writeFileSync(keyFile, 'synthetic-view-key');
  const manifest = validateSourceManifest({
    schemaVersion: 1,
    defaultInstanceId: 'alpha',
    history: { upstreamOrigin: 'http://history.test', managementKeyFile: keyFile },
    analytics: {
      upstreamOrigin: 'http://cpa.test',
      adminKeyFile: '/private/cpa',
      dataset: 'homelab',
    },
    sources: ['alpha', 'beta'].map((id) => ({
      instanceId: id,
      label: id,
      publicBasePath: `/${id}`,
      aliases: [],
      providers: [id === 'alpha' ? 'codex' : 'claude'],
      authScope: 'shared',
      upstreamOrigin: `http://${id}.test`,
      managementKeyFile: `/private/${id}`,
    })),
  });
  const calls: { url: string; key: string; body?: Record<string, unknown> }[] = [];
  let betaFailed = false;
  let cpaStatus = 200;
  let now = 1_000_000_000_000;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = new Headers(init?.headers).get('Authorization') ?? '';
    calls.push({ url, key, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    expect(init?.redirect).toBe('error');
    if (url.includes('beta.test') && betaFailed)
      return new Response('private detail', { status: 401 });
    if (url.endsWith('/config/access/api-keys'))
      return Response.json([url.includes('alpha') ? 'alpha-client' : 'beta-client']);
    if (url.endsWith('/v1/models'))
      return Response.json({ data: [{ id: 'same-model', owned_by: 'publisher' }] });
    if (cpaStatus !== 200)
      return new Response('private cpa credential leak sentinel', { status: cpaStatus });
    return Response.json({
      generated_at_ms: calls.filter((call) => call.url.startsWith('http://cpa.test')).length,
      schema_version: 1,
      summary: {},
      coverage: {},
      requests: {},
      rates: [],
      timeline: [],
    });
  }) as typeof fetch;
  return {
    manifest,
    calls,
    handler: createAnalyticsHandler(
      manifest,
      fetcher,
      async (path) => `key-for-${path}`,
      () => now
    ),
    cpaCalls: () => calls.filter((call) => call.url.startsWith('http://cpa.test')).length,
    catalogCalls: () => calls.filter((call) => !call.url.startsWith('http://cpa.test')).length,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    now: () => now,
    failBeta: () => {
      betaFailed = true;
    },
    restoreBeta: () => {
      betaFailed = false;
    },
    failCpa: (status: number) => {
      cpaStatus = status;
    },
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const query = { from_ms: 1000, to_ms: 2000, time_zone: 'UTC', granularity: 'hour', outcome: 'all' };
const request = (body: unknown = query, key = 'synthetic-view-key', headers = {}) =>
  new Request('http://history.test/v1/analytics', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });

describe('Prox analytics bridge', () => {
  test('authenticates before querying any source', async () => {
    const f = fixture();
    try {
      expect((await f.handler(request(query, 'wrong'))).status).toBe(401);
      expect(f.calls).toHaveLength(0);
    } finally {
      f.clean();
    }
  });
  test('rejects caller destinations/catalog and oversized payloads', async () => {
    const f = fixture();
    try {
      for (const body of [
        { ...query, catalog: [] },
        { ...query, url: 'http://evil.test' },
        { ...query, search: 'x'.repeat(17000) },
      ])
        expect((await f.handler(request(body))).status).toBe(400);
      expect(f.calls).toHaveLength(0);
    } finally {
      f.clean();
    }
  });
  test('pins credentials to their owners and preserves both registered occurrences', async () => {
    const f = fixture();
    try {
      const response = await f.handler(request());
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const data = await response.json();
      expect(data.catalog_sources.map((row: { state: string }) => row.state)).toEqual([
        'ready',
        'ready',
      ]);
      const cpa = f.calls.find((call) => call.url.startsWith('http://cpa.test'))!;
      expect(cpa.key).toBe('Bearer key-for-/private/cpa');
      expect(cpa.body?.catalog).toEqual(
        ['alpha', 'beta'].map((id) => ({
          instance_id: id,
          instance_label: id,
          provider: 'publisher',
          id: 'same-model',
        }))
      );
      expect(
        f.calls.filter((call) => call.url.endsWith('/v1/models')).map((call) => call.key)
      ).toEqual(['Bearer alpha-client', 'Bearer beta-client']);
      expect(JSON.stringify(data)).not.toContain('key-for');
    } finally {
      f.clean();
    }
  });
  test('isolates catalog failure and sanitizes CPA errors', async () => {
    const f = fixture();
    try {
      const bypass = { 'Cache-Control': 'no-cache' };
      f.failBeta();
      const data = await (await f.handler(request(query, undefined, bypass))).json();
      expect(data.catalog_sources.map((row: { state: string }) => row.state)).toEqual([
        'ready',
        'unavailable',
      ]);
      f.failCpa(401);
      const failed = await f.handler(request(query, undefined, bypass));
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain('sentinel');
      f.failCpa(400);
      expect((await f.handler(request(query, undefined, bypass))).status).toBe(400);
    } finally {
      f.clean();
    }
  });
  describe('snapshot cache', () => {
    const DAY = 86_400_000;
    // A rolling window as the page builds it: both ends come from the caller's own clock.
    const live = (f: { now: () => number }, span = 7 * DAY, extra = {}) => ({
      ...query,
      from_ms: f.now() - span,
      to_ms: f.now(),
      ...extra,
    });
    const settle = () => Bun.sleep(10);
    const generation = async (response: Response) => (await response.json()).generated_at_ms;

    test('serves a repeated live view without asking CPA again, whatever the caller clock says', async () => {
      const f = fixture();
      try {
        expect(await generation(await f.handler(request(live(f))))).toBe(1);
        f.advance(5000);
        expect(await generation(await f.handler(request(live(f))))).toBe(1);
        expect(f.cpaCalls()).toBe(1);
      } finally {
        f.clean();
      }
    });
    test('answers a stale view at once and refreshes behind it', async () => {
      const f = fixture();
      try {
        await f.handler(request(live(f)));
        f.advance(5 * 60_000);
        expect(await generation(await f.handler(request(live(f))))).toBe(1);
        await settle();
        expect(f.cpaCalls()).toBe(2);
        expect(await generation(await f.handler(request(live(f))))).toBe(2);
      } finally {
        f.clean();
      }
    });
    test('shares one CPA query between concurrent first requests', async () => {
      const f = fixture();
      try {
        const responses = await Promise.all([
          f.handler(request(live(f))),
          f.handler(request(live(f))),
          f.handler(request(live(f))),
        ]);
        expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(f.cpaCalls()).toBe(1);
      } finally {
        f.clean();
      }
    });
    test('recomputes when the caller asks for fresh data', async () => {
      const f = fixture();
      try {
        await f.handler(request(live(f)));
        const bypass = { 'Cache-Control': 'no-cache' };
        expect(await generation(await f.handler(request(live(f), undefined, bypass)))).toBe(2);
        expect(await generation(await f.handler(request(live(f))))).toBe(2);
      } finally {
        f.clean();
      }
    });
    test('keeps distinct views apart and never shares a cursor page or a fixed window', async () => {
      const f = fixture();
      try {
        await f.handler(request(live(f, 7 * DAY)));
        await f.handler(request(live(f, 30 * DAY)));
        await f.handler(request(live(f, 7 * DAY, { provider: 'publisher' })));
        await f.handler(request(live(f, 7 * DAY, { before_ms: 5, before_id: 'x' })));
        await f.handler(request(query));
        expect(f.cpaCalls()).toBe(5);
        await f.handler(request(query));
        expect(f.cpaCalls()).toBe(5);
      } finally {
        f.clean();
      }
    });
    test('does not cache a failure and keeps serving the last good snapshot through one', async () => {
      const f = fixture();
      try {
        f.failCpa(500);
        expect((await f.handler(request(live(f)))).status).toBe(503);
        f.failCpa(200);
        expect(await generation(await f.handler(request(live(f))))).toBe(2);
        f.failCpa(500);
        f.advance(5 * 60_000);
        expect(await generation(await f.handler(request(live(f))))).toBe(2);
        await settle();
        expect(await generation(await f.handler(request(live(f))))).toBe(2);
      } finally {
        f.clean();
      }
    });
    test('warming refreshes the default views before anyone asks', async () => {
      const f = fixture();
      try {
        await f.handler.warm();
        const seeded = f.cpaCalls();
        expect(seeded).toBeGreaterThanOrEqual(7);
        f.advance(5000);
        await f.handler.warm();
        expect(f.cpaCalls()).toBe(seeded);
        // Someone is using the page, so the views keep their active cadence.
        await f.handler(request(live(f, 30 * DAY, { granularity: 'day', limit: 25 })));
        f.advance(10 * 60_000);
        await f.handler.warm();
        expect(f.cpaCalls()).toBe(seeded * 2);
        const before = f.cpaCalls();
        const response = await f.handler(
          request(live(f, 30 * DAY, { granularity: 'day', limit: 25 }))
        );
        expect(response.status).toBe(200);
        expect(f.cpaCalls()).toBe(before);
      } finally {
        f.clean();
      }
    });
    test('backs off to a slow heartbeat when idle, and the first visit still answers from the snapshot', async () => {
      const f = fixture();
      try {
        await f.handler.warm();
        const seeded = f.cpaCalls();
        f.advance(20 * 60_000);
        await f.handler.warm();
        expect(f.cpaCalls()).toBe(seeded);
        f.advance(15 * 60_000);
        await f.handler.warm();
        expect(f.cpaCalls()).toBe(seeded * 2);
        // Hours later, long past any stale limit: the old snapshot is served at once.
        f.advance(3 * 60 * 60_000);
        const before = f.cpaCalls();
        const first = await f.handler(
          request(live(f, 30 * DAY, { granularity: 'day', limit: 25 }))
        );
        expect(await generation(first)).toBeLessThanOrEqual(before);
        await settle();
        expect(f.cpaCalls()).toBe(before + 1);
        // The visit wakes the warmer: the other views refresh on the active cadence again.
        f.advance(60_000);
        await f.handler.warm();
        expect(f.cpaCalls()).toBe(before + 1 + seeded);
      } finally {
        f.clean();
      }
    });
    test('warms the dashboard traffic view for every provider the sources declare', async () => {
      const f = fixture();
      try {
        await f.handler.warm();
        const before = f.cpaCalls();
        for (const provider of ['codex', 'claude']) {
          const response = await f.handler(request(dashboardAnalyticsQuery(f.now(), provider)));
          expect(response.status).toBe(200);
        }
        expect(f.cpaCalls()).toBe(before);
        await f.handler(request(dashboardAnalyticsQuery(f.now(), 'gemini')));
        expect(f.cpaCalls()).toBe(before + 1);
      } finally {
        f.clean();
      }
    });
  });
  describe('catalog reuse', () => {
    const DAY = 86_400_000;
    const view = (f: { now: () => number }, span: number) => ({
      ...query,
      from_ms: f.now() - span,
      to_ms: f.now(),
    });
    test('reads the catalog once for several views, and again after a few minutes', async () => {
      const f = fixture();
      try {
        await f.handler(request(view(f, 7 * DAY)));
        await f.handler(request(view(f, 30 * DAY)));
        expect(f.cpaCalls()).toBe(2);
        expect(f.catalogCalls()).toBe(4);
        f.advance(6 * 60_000);
        await f.handler(request(view(f, DAY)));
        expect(f.catalogCalls()).toBe(8);
      } finally {
        f.clean();
      }
    });
    test('never keeps a failed source: it reads unavailable, then recovers at once', async () => {
      const f = fixture();
      try {
        f.failBeta();
        const states = async (span: number) =>
          (await (await f.handler(request(view(f, span)))).json()).catalog_sources.map(
            (row: { state: string }) => row.state
          );
        expect(await states(7 * DAY)).toEqual(['ready', 'unavailable']);
        expect(await states(30 * DAY)).toEqual(['ready', 'unavailable']);
        f.restoreBeta();
        expect(await states(DAY)).toEqual(['ready', 'ready']);
      } finally {
        f.clean();
      }
    });
  });
  test('keeps the dataset grant private and validates its configured origin', () => {
    const f = fixture();
    try {
      const publicData = publicSourceDiscovery(f.manifest, 'a'.repeat(64));
      expect(JSON.stringify(publicData)).not.toContain('cpa');
      expect(() =>
        validateSourceManifest({
          ...f.manifest,
          analytics: { ...f.manifest.analytics, upstreamOrigin: 'http://cpa.test/evil' },
        })
      ).toThrow();
      expect(() =>
        validateSourceManifest({
          ...f.manifest,
          analytics: { ...f.manifest.analytics, dataset: 'all-tenants' },
        })
      ).toThrow();
    } finally {
      f.clean();
    }
  });
});
