import { expect, test } from 'bun:test';
import { SourceRegistry } from '../src/services/providerSources/registry';
import { fetchSourceDiscovery } from '../src/services/providerSources/discovery';
import type { SourceDiscovery } from '../src/domain/providerSources/types';
const discovery: SourceDiscovery = {
  schemaVersion: 1,
  revision: 'a'.repeat(64),
  defaultInstanceId: 'first',
  sources: [
    {
      instanceId: 'first',
      label: 'First',
      publicBasePath: '/first',
      aliases: [''],
      authScope: 'shared',
    },
    {
      instanceId: 'second',
      label: 'Second',
      publicBasePath: '/second',
      aliases: [],
      authScope: 'shared',
    },
    {
      instanceId: 'third',
      label: 'Third',
      publicBasePath: '/third',
      aliases: [],
      authScope: 'separate',
    },
  ],
};
test('enumerates once and shares credentials only across declared scopes', async () => {
  const registry = new SourceRegistry(async () => discovery);
  await registry.connect('https://fixture.invalid', 'fixture-key', 'https://fixture.invalid');
  const snapshot = registry.getSnapshot();
  expect(snapshot.status).toBe('ready');
  expect(snapshot.sources.map((view) => view.status)).toEqual([
    'ready',
    'ready',
    'authentication-required',
  ]);
  expect(snapshot.sources[2].session).toBeNull();
  expect(snapshot.resolution?.selectedInstanceId).toBe('first');
  expect(JSON.stringify(snapshot)).not.toContain('fixture-key');
});
test('external connection performs no discovery and gets a single source', async () => {
  const registry = new SourceRegistry(async () => {
    throw new Error('must not discover');
  });
  await registry.connect('https://other.invalid/prefix', 'fixture', 'https://fixture.invalid');
  expect(registry.getSnapshot().resolution?.mode).toBe('external');
  expect(registry.getSnapshot().sources).toHaveLength(1);
});
test('unavailable discovery is explicit and is not a successful empty inventory', async () => {
  const registry = new SourceRegistry(async () => {
    throw new Error('unavailable');
  });
  await registry.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  expect(registry.getSnapshot().status).toBe('error');
});
test('logout invalidates all owners and a late discovery cannot resurrect them', async () => {
  const registry = new SourceRegistry(async () => discovery);
  await registry.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  const source = registry.getSnapshot().sources[0].session!;
  registry.reset();
  expect(() => source.assertCurrent()).toThrow();
  let release!: (value: SourceDiscovery) => void;
  const delayed = new SourceRegistry(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = delayed.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  delayed.reset();
  release(discovery);
  await pending;
  expect(delayed.getSnapshot().status).toBe('disconnected');
});
test('source 401 affects only its own registry state', async () => {
  const registry = new SourceRegistry(async () => discovery);
  await registry.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  await expect(
    registry.getSnapshot().sources[1].session!.management.get('/credentials', {
      adapter: async (config) => {
        throw { isAxiosError: true, message: 'Unauthorized', config, response: { status: 401 } };
      },
    })
  ).rejects.toThrow();
  expect(registry.getSnapshot().sources.map((view) => view.status)).toEqual([
    'ready',
    'unauthorized',
    'authentication-required',
  ]);
});
test('discovery transport is passive and validates the public allowlist', async () => {
  const signal = new AbortController().signal;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe('https://fixture.invalid/prox/sources.json');
    expect(init?.headers).toBeUndefined();
    expect(init?.redirect).toBe('error');
    return Response.json(discovery);
  }) as typeof fetch;
  expect(await fetchSourceDiscovery('https://fixture.invalid', signal, fetcher)).toEqual(discovery);
  const malformed = (async () =>
    Response.json({ ...discovery, managementKey: 'sentinel' })) as typeof fetch;
  await expect(
    fetchSourceDiscovery('https://fixture.invalid', signal, malformed)
  ).rejects.toThrow();
  const absent = (async () => new Response('', { status: 404 })) as typeof fetch;
  expect(await fetchSourceDiscovery('https://fixture.invalid', signal, absent)).toBeNull();
});

test('unchanged response metadata preserves snapshot identity and cannot start a refresh loop', async () => {
  const registry = new SourceRegistry(async () => discovery);
  await registry.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  const client = registry.getSnapshot().sources[0].session!.management;
  const adapter = async (config: import('axios').InternalAxiosRequestConfig) => ({
    data: {},
    status: 200,
    statusText: 'OK',
    headers: { 'x-cpa-version': 'v8-test', 'x-cpa-support-plugin': 'true' },
    config,
  });
  await client.get('/config', { adapter });
  const settled = registry.getSnapshot();
  await client.get('/config', { adapter });
  expect(registry.getSnapshot()).toBe(settled);
});

test('source selection honors requested ownership and never falls back on stale links', async () => {
  const { selectSource } = await import('../src/services/providerSources/selection');
  const registry = new SourceRegistry(async () => discovery);
  await registry.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  const snapshot = registry.getSnapshot();
  const beta = snapshot.sources[1].session!;
  expect(selectSource(snapshot, 'second')?.session).toBe(beta);
  expect(selectSource(snapshot, 'not-present')).toBeNull();
  expect(selectSource(snapshot, 'third')).toBeNull();
  expect(selectSource(snapshot, 'second', snapshot.sources[0].session!.owner)).toBeNull();
  const owner = beta.owner;
  await registry.connect('https://fixture.invalid', 'fixture', 'https://fixture.invalid');
  expect(selectSource(registry.getSnapshot(), 'second', owner)).toBeNull();
});
