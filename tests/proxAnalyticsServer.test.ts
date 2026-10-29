import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyticsHandler } from '../server/analytics/handler';
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
      authScope: 'shared',
      upstreamOrigin: `http://${id}.test`,
      managementKeyFile: `/private/${id}`,
    })),
  });
  const calls: { url: string; key: string; body?: Record<string, unknown> }[] = [];
  let betaFailed = false;
  let cpaStatus = 200;
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
    handler: createAnalyticsHandler(manifest, fetcher, async (path) => `key-for-${path}`),
    failBeta: () => {
      betaFailed = true;
    },
    failCpa: (status: number) => {
      cpaStatus = status;
    },
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const query = { from_ms: 1000, to_ms: 2000, time_zone: 'UTC', granularity: 'hour', outcome: 'all' };
const request = (body: unknown = query, key = 'synthetic-view-key') =>
  new Request('http://history.test/v1/analytics', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
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
      f.failBeta();
      const data = await (await f.handler(request())).json();
      expect(data.catalog_sources.map((row: { state: string }) => row.state)).toEqual([
        'ready',
        'unavailable',
      ]);
      f.failCpa(401);
      const failed = await f.handler(request());
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain('sentinel');
      f.failCpa(400);
      expect((await f.handler(request())).status).toBe(400);
    } finally {
      f.clean();
    }
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
