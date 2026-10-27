import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { apiClient } from '@/services/api/client';
import { createSourceLease } from '@/services/api/sourceLease';
import { createPluginsApi, createPluginStoreApi, pluginsApi } from '@/services/api/plugins';
import {
  sourceOwnerKey,
  type ManagementTransport,
  type SourceSession,
} from '@/services/api/sourceSession';
import type { SourceView } from '@/services/providerSources/registry';
import { createPluginPolling } from '@/features/plugins/pluginPolling';
import { createPluginReleaseVersionsApi } from '@/features/plugins/pluginReleaseVersions';
import {
  buildPluginResourceRoute,
  collectPluginResourceEntries,
} from '@/features/plugins/pluginResources';
import {
  loadPluginSourceInventories,
  resolvePluginDestination,
} from '@/features/plugins/pluginSourceInventory';

interface Call {
  source: string;
  method: string;
  path: string;
  body?: unknown;
}
const calls: Call[] = [];
type Handler = (call: Call) => unknown | Promise<unknown>;
function fixture(id: string, handler: Handler, supportsPlugin = true) {
  const controller = new AbortController();
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const call = { source: id, method, path, body };
    calls.push(call);
    return (await handler(call)) as T;
  };
  const management: ManagementTransport = {
    get: <T>(path: string) => request<T>('GET', path),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    delete: <T>(path: string) => request<T>('DELETE', path),
    postForm: <T>(path: string, body: FormData) => request<T>('POST', path, body),
    getRaw: async () => {
      throw new Error('Unexpected raw request');
    },
  };
  const session: SourceSession = {
    owner: { instanceId: id, sessionEpoch: 1, sourceGeneration: 1 },
    management,
    signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted) throw new Error('Source session changed');
    },
  };
  const view: SourceView = {
    source: {
      instanceId: id,
      label: id,
      publicBasePath: `/${id}`,
      aliases: [],
      authScope: id,
      apiBase: `https://${id}.example.test`,
    },
    session,
    status: 'ready',
    version: null,
    supportsPlugin,
  };
  return { session, view, retire: () => controller.abort() };
}
const rawPlugin = (enabled = true) => ({
  id: 'same',
  registered: enabled,
  effective_enabled: enabled,
  enabled,
  menus: [{ menu: 'Page', path: '/plugin/page' }],
});
const inventory = (enabled = true) => ({ plugins_enabled: true, plugins: [rawPlugin(enabled)] });
const singletonSpies = ['get', 'put', 'post', 'delete'].map((method) =>
  spyOn(apiClient, method as 'get').mockImplementation(() => {
    throw new Error('Ambient singleton request');
  })
);
afterEach(() => {
  calls.length = 0;
});
// Keep these traps for this file only; Bun restores them before other suites run.
afterAll(() => singletonSpies.forEach((spy) => spy.mockRestore()));

describe('plugin source ownership', () => {
  test('same local IDs retain separate owners; empty, malformed, auth failure and unsupported remain distinct', async () => {
    const a = fixture('a', () => inventory());
    const b = fixture('b', () => inventory());
    const empty = fixture('empty', () => ({ plugins: [] }));
    const malformed = fixture('malformed', () => ({ plugins: [{ name: 'missing id' }] }));
    const failed = fixture('failed', () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    const unsupported = fixture('unsupported', () => ({}), false);
    const views = [a, b, empty, malformed, failed, unsupported].map((item) => item.view);
    const results = await loadPluginSourceInventories(views, () => views);
    expect(results.map((item) => item.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'unavailable',
      'unavailable',
      'unsupported',
    ]);
    expect(results[3]).toMatchObject({ status: 'unavailable', reason: 'malformed' });
    expect(results[4]).toMatchObject({ status: 'unavailable', reason: 'authentication' });
    const complete = results.filter((item) => item.status === 'complete');
    expect(
      complete.map((item) => [item.view.source.instanceId, item.response.plugins.map((p) => p.id)])
    ).toEqual([
      ['a', ['same']],
      ['b', ['same']],
      ['empty', []],
    ]);
    await createPluginsApi(b.session).updateEnabled('same', false);
    await createPluginsApi(a.session).deletePlugin('same');
    expect(calls.slice(-2).map(({ source, method }) => [source, method])).toEqual([
      ['b', 'PUT'],
      ['a', 'DELETE'],
    ]);
    expect(calls.filter((call) => call.source === 'unsupported').map((call) => call.path)).toEqual([
      '/config',
    ]);
  });

  test('initial false capability probes passively and never publishes config secrets', async () => {
    let views: SourceView[] = [];
    const source = fixture(
      'a',
      ({ path }) => {
        if (path === '/config') {
          views = [{ ...source.view, supportsPlugin: true }];
          return { key: 'SYNTHETIC_SECRET_SENTINEL' };
        }
        return inventory();
      },
      false
    );
    views = [source.view];
    const result = await loadPluginSourceInventories(views, () => views);
    expect(result[0].status).toBe('complete');
    expect(calls.map((call) => call.path)).toEqual(['/config', '/plugins']);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_SENTINEL');
  });

  test('config read-modify-write and install options stay on the captured owner', async () => {
    const a = fixture('a', () => ({ keep: 1, clear: 'old', object: { old: true } }));
    const api = createPluginsApi(a.session);
    await api.patchConfig('same/id', { clear: null, object: { next: true } });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', '/config/plugins/configs/same%2Fid'],
      ['PUT', '/config/plugins/configs/same%2Fid'],
    ]);
    expect(calls[1].body).toEqual({ keep: 1, object: { next: true } });
    await createPluginStoreApi(a.session).install('same', {
      sourceId: 'third-party',
      version: 'v2',
    });
    expect(calls.at(-1)).toEqual({
      source: 'a',
      method: 'POST',
      path: '/plugins/store/same/install?source=third-party&version=v2',
      body: { version: 'v2' },
    });
  });

  test('stale config reads cannot dispatch their dependent write, even if the ID reconnects', async () => {
    let resolve!: (value: unknown) => void;
    const a = fixture(
      'a',
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = createPluginsApi(a.session).patchConfig('same', { enabled: true });
    a.retire();
    const replacement = fixture('a', () => inventory());
    resolve({ enabled: false });
    await expect(pending).rejects.toThrow('Source session changed');
    expect(calls).toHaveLength(1);
    expect(await createPluginsApi(replacement.session).list()).toHaveProperty('plugins');
  });

  test('polling keeps the owner on each iteration and stops dispatch after retirement', async () => {
    let count = 0;
    const a = fixture('a', () => inventory(++count > 1));
    const result = await createPluginPolling(a.session).waitForPluginState(
      'same',
      (plugin) => plugin.effectiveEnabled,
      100,
      1
    );
    expect(result.timedOut).toBe(false);
    expect(calls.map((call) => call.source)).toEqual(['a', 'a']);
    const b = fixture('b', () => inventory(false));
    await expect(
      createPluginPolling(b.session).waitForPluginState(
        'same',
        () => {
          b.retire();
          return false;
        },
        100,
        1
      )
    ).rejects.toThrow('Source session changed');
    expect(calls.filter((call) => call.source === 'b')).toHaveLength(1);
  });

  test('store polling distinguishes registry source IDs and release API-call uses the same destination', async () => {
    let count = 0;
    const a = fixture('a', ({ path }) => {
      if (path === '/requests/api-call')
        return { status_code: 200, body: [{ tag_name: 'v2', assets: [] }] };
      count += 1;
      return {
        plugins: [
          { id: 'same', source_id: 'other', installed: true },
          { id: 'same', source_id: 'wanted', installed: count > 1 },
        ],
      };
    });
    const result = await createPluginPolling(a.session).waitForPluginStoreState(
      'same',
      'wanted',
      (plugin) => plugin.installed,
      100,
      1
    );
    expect(result.plugin?.sourceId).toBe('wanted');
    expect(result.timedOut).toBe(false);
    const releases = await createPluginReleaseVersionsApi(a.session).fetchPluginReleaseVersions(
      'owner/repo'
    );
    expect(releases[0].tagName).toBe('v2');
    expect(calls.at(-1)).toMatchObject({
      source: 'a',
      method: 'POST',
      path: '/requests/api-call',
      body: { method: 'GET', url: 'https://api.github.com/repos/owner/repo/releases?per_page=50' },
    });
    expect(calls.every((call) => call.source === 'a')).toBe(true);
  });

  test('late inventory results are stale and do not replace healthy source results', async () => {
    const a = fixture('a', () => {
      a.retire();
      return inventory();
    });
    const b = fixture('b', () => inventory());
    const views = [a.view, b.view];
    const results = await loadPluginSourceInventories(views, () => views);
    expect(results.map((result) => result.status)).toEqual(['stale', 'complete']);
  });

  test('resource routes carry their source and destination selection never guesses an explicit owner', async () => {
    const a = fixture('a', () => inventory());
    const b = fixture('b', () => inventory());
    const views = [a.view, b.view];
    expect(resolvePluginDestination(views, null, false, 'a')).toBeUndefined();
    expect(resolvePluginDestination(views, 'missing', true, 'a')).toBeUndefined();
    expect(resolvePluginDestination(views, null, true, 'a')).toBe(a.view);
    expect(resolvePluginDestination(views, 'b', false, 'a')).toBe(b.view);
    const response = await createPluginsApi(b.session).list();
    expect(collectPluginResourceEntries(response.plugins, 'b')[0]).toMatchObject({
      instanceId: 'b',
      route: '/plugin-pages/same/0?source=b',
    });
    expect(buildPluginResourceRoute('same/id', 1)).toBe('/plugin-pages/same%2Fid/1');
    expect(sourceOwnerKey(a.session.owner)).not.toBe(sourceOwnerKey(b.session.owner));
  });

  test('disposed views block confirmations, nested polling and late release results while the source stays authenticated', async () => {
    let resolve!: (value: unknown) => void;
    const a = fixture(
      'a',
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const lease = createSourceLease(a.session);
    const releases = createPluginReleaseVersionsApi(lease.session).fetchPluginReleaseVersions(
      'owner/repo'
    );
    lease.dispose();
    resolve({ status_code: 200, body: [{ tag_name: 'v2' }] });
    await expect(releases).rejects.toThrow('Source view closed');
    await expect(createPluginsApi(lease.session).deletePlugin('same')).rejects.toThrow(
      'Source view closed'
    );
    await expect(
      createPluginPolling(lease.session).waitForPluginState('same', () => true)
    ).rejects.toThrow('Source view closed');
    expect(calls).toHaveLength(1);
    expect(a.session.signal.aborted).toBe(false);
    a.session.assertCurrent();
  });

  test('legacy list(transport) remains injectable', async () => {
    const a = fixture('a', () => inventory());
    expect((await pluginsApi.list(a.session.management)).plugins[0].id).toBe('same');
    expect(calls[0].source).toBe('a');
  });

  test('scoped feature request chains have no ambient API imports and deployment resources are blocked', () => {
    for (const file of [
      'PluginsPage.tsx',
      'PluginStorePage.tsx',
      'PluginResourcePage.tsx',
      'pluginPolling.ts',
      'pluginReleaseVersions.ts',
      'pluginSourceInventory.ts',
    ]) {
      const source = readFileSync(
        new URL(`../src/features/plugins/${file}`, import.meta.url),
        'utf8'
      );
      const imports = source.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const statement of imports)
        expect(statement).not.toMatch(
          /import\s*\{[^}]*\b(apiClient|apiCallApi|pluginsApi|pluginStoreApi)\b/
        );
    }
    const boundary = readFileSync(
      new URL('../src/features/plugins/PluginSourceScope.tsx', import.meta.url),
      'utf8'
    );
    expect(boundary).toContain('resource && !external');
    expect(boundary).toContain('plugin_resource.source_embedding_unsupported');
    expect(boundary).not.toContain('managementKey');
  });
});
