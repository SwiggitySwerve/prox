import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import axios from 'axios';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { ResolvedSource } from '@/domain/providerSources/types';
import type { ManagementTransport, SourceSession } from '@/services/api/sourceSession';
import { createProvidersApi, providersApi } from '@/services/api/providers';
import { createConfigApi } from '@/services/api/config';
import { createApiKeysApi } from '@/services/api/apiKeys';
import { createModelsApi } from '@/services/api/models';
import { apiClient } from '@/services/api/client';
import type { ApiCallRequest } from '@/services/api/apiCall';
import { createProviderSourceScope } from '@/features/providers/sourceScope';
import { ProvidersWorkbenchPage } from '@/features/providers/ProvidersWorkbenchPage';
import { createConfigStore } from '@/stores/useConfigStore';
import { createModelsStore } from '@/stores/useModelsStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { notifySourceConfigChanged } from '@/services/api/sourceConfigChanges';
import { providerSources } from '@/stores/useProviderSources';
import { fetchProviderRecentRequests } from '@/components/providers/recentRequests';
import { createApiKeysForModelsLoader } from '@/hooks/useApiKeysForModels';
import type { Config } from '@/types';

const restores: Array<() => void> = [];
afterEach(() => {
  restores.splice(0).forEach((restore) => restore());
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const inventory = (families = ['claude']) => ({
  'api-keys': Object.fromEntries(
    families.map((family) => [
      family,
      [
        {
          name: 'same-name',
          'base-url': 'https://upstream.invalid',
          keys: [{ 'api-key': 'same-provider-key', 'future-field': 'retain' }],
        },
      ],
    ])
  ),
});
function fixture(instanceId: string, families = ['claude']) {
  const controller = new AbortController();
  let raw: unknown = inventory(families);
  let read: ((path: string) => Promise<unknown>) | undefined;
  let post: ((path: string, data: unknown) => Promise<unknown>) | undefined;
  let put: ((path: string, data: unknown) => Promise<unknown>) | undefined;
  const calls: Array<{ method: string; path: string; data?: unknown }> = [];
  const transport: ManagementTransport = {
    get: async <T>(path: string) => {
      calls.push({ method: 'GET', path });
      const value = read
        ? await read(path)
        : path === '/config'
          ? structuredClone(raw)
          : path === '/config/access/api-keys'
            ? [`client-${instanceId}`]
            : {};
      return value as T;
    },
    post: async <T>(path: string, data?: unknown) => {
      calls.push({ method: 'POST', path, data });
      return (
        post ? await post(path, data) : { status_code: 200, body: { data: [{ id: instanceId }] } }
      ) as T;
    },
    put: async <T>(path: string, data?: unknown) => {
      calls.push({ method: 'PUT', path, data });
      return (put ? await put(path, data) : {}) as T;
    },
    patch: async () => {
      throw new Error('Unexpected PATCH');
    },
    delete: async () => {
      throw new Error('Unexpected DELETE');
    },
    getRaw: async () => {
      throw new Error('Unexpected raw request');
    },
    postForm: async () => {
      throw new Error('Unexpected form request');
    },
  };
  const session: SourceSession = {
    owner: { instanceId, sessionEpoch: 1, sourceGeneration: 1 },
    signal: controller.signal,
    management: transport,
    assertCurrent: () => {
      if (controller.signal.aborted) throw new Error('Source session changed');
    },
  };
  const source: ResolvedSource = {
    instanceId,
    label: `Source ${instanceId}`,
    apiBase: `https://${instanceId}.invalid`,
    publicBasePath: '',
    aliases: [],
    authScope: 'test',
  };
  return {
    session,
    source,
    calls,
    retire: () => controller.abort(),
    setRaw: (value: unknown) => {
      raw = value;
    },
    onGet: (handler: typeof read) => {
      read = handler;
    },
    onPost: (handler: typeof post) => {
      post = handler;
    },
    onPut: (handler: typeof put) => {
      put = handler;
    },
  };
}

function forbidAmbientRequests() {
  for (const method of ['get', 'post', 'put'] as const) {
    const spy = spyOn(apiClient, method).mockImplementation(async () => {
      throw new Error('Ambient request');
    });
    restores.push(() => spy.mockRestore());
  }
}

describe('provider source workbench ownership', () => {
  test('enumerates A/B same-provider and C mixed-provider sources independently of selection', () => {
    const sources = [fixture('a'), fixture('b'), fixture('c', ['claude', 'codex'])];
    const spy = spyOn(providerSources, 'getSnapshot').mockReturnValue({
      status: 'ready',
      resolution: {
        mode: 'deployment',
        revision: '1',
        selectedInstanceId: 'b',
        sources: sources.map((f) => f.source),
      },
      sources: sources.map((f) => ({
        source: f.source,
        session: f.session,
        status: 'ready',
        version: null,
        supportsPlugin: false,
      })),
    });
    restores.push(() => spy.mockRestore());
    const html = renderToStaticMarkup(createElement(ProvidersWorkbenchPage));
    for (const f of sources) {
      expect(html).toContain(`data-source-id="${f.source.instanceId}"`);
      expect(html).toContain(f.source.label);
      expect(f.calls).toHaveLength(0);
    }
    expect(html).not.toContain('same-provider-key');
  });

  test('passive config inventory preserves every occurrence and does not dispatch probes', async () => {
    forbidAmbientRequests();
    const sources = [fixture('a'), fixture('b'), fixture('c', ['claude', 'codex'])];
    const scopes = sources.map((f) => createProviderSourceScope(f.session, f.source));
    const configs = await Promise.all(
      scopes.map((scope) => scope.configStore.getState().fetchConfig())
    );
    expect(configs.map((config) => config.claudeApiKeys?.length)).toEqual([1, 1, 1]);
    expect(configs[2].codexApiKeys).toHaveLength(1);
    for (const f of sources) expect(f.calls).toEqual([{ method: 'GET', path: '/config' }]);
    scopes.forEach((scope) => scope.dispose());
  });

  test('same-name provider edits and nested client-key replacements stay on the captured owner', async () => {
    forbidAmbientRequests();
    const a = fixture('a');
    const b = fixture('b');
    const apiA = createProvidersApi(a.session);
    const config = await createConfigApi(a.session).getConfig();
    const key = config.claudeApiKeys![0];
    await createConfigApi(b.session).getConfig();
    await apiA.updateClaudeConfig(key.apiKey, key.baseUrl, { ...key, priority: 7 });
    await createApiKeysApi(a.session).update(0, 'rotated-client-a');
    expect(a.calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([
      '/config/api-keys/claude',
      '/config/access/api-keys',
    ]);
    const written = a.calls.find((call) => call.path === '/config/api-keys/claude')!.data;
    expect(JSON.stringify(written)).toContain('future-field');
    expect(JSON.stringify(written)).toContain('"priority":7');
    expect(b.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  test('retiring a source during read prevents dependent provider and API-key writes', async () => {
    for (const kind of ['provider', 'client-key'] as const) {
      const a = fixture('a');
      const pending = deferred<unknown>();
      a.onGet(() => pending.promise);
      const action =
        kind === 'provider'
          ? createProvidersApi(a.session).createClaudeConfig({ apiKey: 'new' })
          : createApiKeysApi(a.session).delete(0);
      a.retire();
      pending.resolve(kind === 'provider' ? inventory() : ['client-a']);
      await expect(action).rejects.toThrow('Source session changed');
      expect(a.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    }
  });

  test('closing a panel or replaying its lease rejects pending responses and queued operations', async () => {
    const a = fixture('a');
    const scope = createProviderSourceScope(a.session, a.source);
    const pending = deferred<unknown>();
    a.onGet(() => pending.promise);
    const action = scope.providersApi.createClaudeConfig({ apiKey: 'new' });
    scope.dispose();
    scope.activate();
    pending.resolve(inventory());
    await expect(action).rejects.toThrow('Source view changed');
    expect(a.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    scope.dispose();
    await expect(
      scope.apiCallApi.request({ method: 'GET', url: 'https://upstream.invalid' })
    ).rejects.toThrow('Source view closed');
    expect(a.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  test('a dispatched write with an expired owner rejects its outcome without touching another source', async () => {
    const a = fixture('a');
    const b = fixture('b');
    a.onPut(async () => {
      a.retire();
      return {};
    });
    await expect(
      createProvidersApi(a.session).createClaudeConfig({ apiKey: 'new' })
    ).rejects.toThrow('Source session changed');
    expect(a.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  test.each([
    null,
    [],
    { 'api-keys': [] },
    { 'api-keys': { claude: {} } },
    { 'api-keys': { claude: [{ keys: ['bad'] }] } },
  ])('malformed source inventory rejects instead of becoming complete-empty: %j', async (raw) => {
    const a = fixture('a');
    a.setRaw(raw);
    const store = createConfigStore(createConfigApi(a.session));
    await expect(store.getState().fetchConfig()).rejects.toThrow();
    expect(store.getState().config).toBeNull();
    expect(store.getState().isCacheValid()).toBe(false);
  });

  test('empty and unavailable inventories stay distinct and secondary failure leaves A usable', async () => {
    const a = fixture('a');
    const b = fixture('b');
    a.setRaw({});
    b.onGet(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    });
    const storeA = createConfigStore(createConfigApi(a.session));
    const storeB = createConfigStore(createConfigApi(b.session));
    const result = await Promise.allSettled([
      storeA.getState().fetchConfig(),
      storeB.getState().fetchConfig(),
    ]);
    expect(result.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
    expect(storeA.getState().config?.claudeApiKeys).toEqual([]);
    expect(storeB.getState().config).toBeNull();
    await expect(
      createProvidersApi(a.session).createClaudeConfig({ apiKey: 'new' })
    ).resolves.toBeUndefined();
  });

  test('config TTL, in-flight deduplication and clear tokens are per store instance', async () => {
    const pending = deferred<Config>();
    let countA = 0;
    const a = createConfigStore({
      getConfig: () => {
        countA++;
        return pending.promise;
      },
    });
    const b = createConfigStore({ getConfig: async () => ({ debug: true }) });
    const old = a.getState().fetchConfig();
    const duplicate = a.getState().fetchConfig();
    await b.getState().fetchConfig();
    a.getState().clearCache();
    pending.resolve({ debug: false });
    await Promise.all([old, duplicate]);
    expect(countA).toBe(1);
    expect(a.getState().config).toBeNull();
    expect(b.getState().config?.debug).toBe(true);
    expect(b.getState().isCacheValid()).toBe(true);
  });

  test('model store cache and latest-request tokens do not invalidate another source', async () => {
    const pending = deferred<Array<{ name: string }>>();
    const a = createModelsStore({ fetchModels: () => pending.promise });
    const b = createModelsStore({ fetchModels: async () => [{ name: 'b' }] });
    const old = a.getState().fetchModels('same-url', 'same-client-key');
    await b.getState().fetchModels('same-url', 'same-client-key');
    a.getState().clearCache();
    pending.resolve([{ name: 'a' }]);
    await old;
    expect(a.getState().models).toEqual([]);
    expect(b.getState().models).toEqual([{ name: 'b' }]);
    expect(b.getState().isCacheValid('same-url', 'same-client-key')).toBe(true);
  });

  test('Gemini pagination and concurrent discovery deduplication are isolated by source', async () => {
    forbidAmbientRequests();
    const sources = [fixture('a'), fixture('b')];
    for (const f of sources)
      f.onPost(async (_path, data) => {
        const url = new URL((data as ApiCallRequest).url);
        const second = url.searchParams.has('pageToken');
        return {
          status_code: 200,
          body: {
            models: [{ name: `models/${f.source.instanceId}-${second ? '2' : '1'}` }],
            ...(second ? {} : { nextPageToken: 'next' }),
          },
        };
      });
    const apis = sources.map((f) =>
      createModelsApi(f.session, { modelsUrl: `${f.source.apiBase}/v1/models` })
    );
    const discover = (api: (typeof apis)[number]) =>
      api.fetchGeminiModelsViaApiCall(
        'https://upstream.invalid',
        'same-key',
        {},
        'same-index',
        'direct'
      );
    const [a, duplicate, b] = await Promise.all([
      discover(apis[0]),
      discover(apis[0]),
      discover(apis[1]),
    ]);
    expect(a.map((model) => model.name)).toEqual(['a-1', 'a-2']);
    expect(duplicate).toEqual(a);
    expect(b.map((model) => model.name)).toEqual(['b-1', 'b-2']);
    for (const f of sources) {
      expect(f.calls).toHaveLength(2);
      for (const call of f.calls)
        expect(call.data).toMatchObject({ authIndex: 'same-index', proxy_url: 'direct' });
    }
  });

  test('retirement during pagination prevents the next page from dispatching', async () => {
    const a = fixture('a');
    a.onPost(async () => {
      a.retire();
      return { status_code: 200, body: { models: [], nextPageToken: 'next' } };
    });
    const api = createModelsApi(a.session, { modelsUrl: `${a.source.apiBase}/v1/models` });
    await expect(
      api.fetchGeminiModelsViaApiCall('https://upstream.invalid', 'key')
    ).rejects.toThrow('Source session changed');
    expect(a.calls).toHaveLength(1);
  });

  test('catalog pins the owner URL and accepts only its client keys, never management credentials or headers', async () => {
    forbidAmbientRequests();
    const a = fixture('a');
    const http = spyOn(axios, 'get').mockResolvedValue({ data: { data: [{ id: 'catalog-a' }] } });
    restores.push(() => http.mockRestore());
    const api = createModelsApi(a.session, { modelsUrl: 'https://a.invalid/v1/models' });
    const models = await api.fetchModels('https://other.invalid', undefined, {
      Authorization: 'Bearer management-sentinel',
    });
    expect(models.map((model) => model.name)).toEqual(['catalog-a']);
    expect(http.mock.calls[0]).toEqual([
      'https://a.invalid/v1/models',
      {
        headers: { Authorization: 'Bearer client-a' },
        signal: a.session.signal,
      },
    ]);
    await expect(api.fetchModels('https://a.invalid', 'management-sentinel')).rejects.toThrow(
      'client API key'
    );
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(http.mock.calls)).not.toContain('management-sentinel');
  });

  test('catalog rejects a delayed result from a retired source', async () => {
    const a = fixture('a');
    const pending = deferred<{ data: unknown }>();
    const http = spyOn(axios, 'get').mockImplementation(() => pending.promise);
    restores.push(() => http.mockRestore());
    const api = createModelsApi(a.session, { modelsUrl: 'https://a.invalid/v1/models' });
    const result = api.fetchModels('https://a.invalid');
    while (http.mock.calls.length === 0) await Promise.resolve();
    a.retire();
    pending.resolve({ data: { data: [{ id: 'late' }] } });
    await expect(result).rejects.toThrow('Source session changed');
  });

  test('recent requests use independent owner caches and reject late publication after disposal', async () => {
    const a = fixture('a');
    const b = fixture('b');
    const scopeA = createProviderSourceScope(a.session, a.source);
    const scopeB = createProviderSourceScope(b.session, b.source);
    const pending = deferred<unknown>();
    a.onGet(() => pending.promise);
    b.onGet(async () => ({ claude: {} }));
    const old = fetchProviderRecentRequests(scopeA.recentRequestsCache, scopeA.apiKeyUsageApi);
    await fetchProviderRecentRequests(scopeB.recentRequestsCache, scopeB.apiKeyUsageApi);
    scopeA.dispose();
    pending.resolve({ codex: {} });
    await expect(old).rejects.toThrow('Source view closed');
    expect(scopeA.recentRequestsCache.cachedAt).toBe(0);
    expect([...scopeB.recentRequestsCache.cachedUsageByProvider.keys()]).toEqual(['claude']);
    scopeB.dispose();
  });

  test('client-key loaders reject late owners and never poison a replacement loader', async () => {
    const a = fixture('a');
    const b = fixture('b');
    const pending = deferred<unknown>();
    a.onGet(() => pending.promise);
    const loadA = createApiKeysForModelsLoader(
      createApiKeysApi(a.session),
      undefined,
      a.session.assertCurrent
    );
    const loadB = createApiKeysForModelsLoader(
      createApiKeysApi(b.session),
      undefined,
      b.session.assertCurrent
    );
    const old = loadA();
    a.retire();
    pending.resolve(['client-a']);
    await expect(old).rejects.toThrow();
    expect(await loadB()).toEqual(['client-b']);
    expect(await loadB()).toEqual(['client-b']);
    expect(b.calls).toHaveLength(1);
  });

  test('legacy read guard also covers a switch between the completed read and dependent write', async () => {
    const pending = deferred<unknown>();
    const saved = useAuthStore.getState();
    let apiBase = 'https://a.invalid';
    const auth = spyOn(useAuthStore, 'getState').mockImplementation(() => ({ ...saved, apiBase }));
    const get = spyOn(apiClient, 'get').mockImplementation(() => pending.promise);
    const put = spyOn(apiClient, 'put').mockResolvedValue({});
    restores.push(
      () => auth.mockRestore(),
      () => get.mockRestore(),
      () => put.mockRestore()
    );
    const action = providersApi.createClaudeConfig({ apiKey: 'new' });
    pending.resolve(inventory());
    await Promise.resolve();
    apiBase = 'https://b.invalid';
    await expect(action).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });

  test('config mutation events invalidate matching owner stores across views only', async () => {
    const a = fixture('a');
    const b = fixture('b');
    const scopes = [
      createProviderSourceScope(a.session, a.source),
      createProviderSourceScope(a.session, a.source),
      createProviderSourceScope(b.session, b.source),
    ];
    scopes.forEach((scope) => scope.activate());
    await Promise.all(scopes.map((scope) => scope.configStore.getState().fetchConfig()));
    scopes.forEach((scope) => scope.modelsStore.setState({ models: [{ name: 'cached' }] }));
    notifySourceConfigChanged({ ...a.session.owner, sourceGeneration: 0 });
    expect(scopes.every((scope) => scope.configStore.getState().isCacheValid())).toBe(true);
    notifySourceConfigChanged(a.session.owner);
    expect(scopes.map((scope) => scope.configStore.getState().isCacheValid())).toEqual([
      false,
      false,
      true,
    ]);
    expect(scopes.map((scope) => scope.modelsStore.getState().models.length)).toEqual([0, 0, 1]);
    expect(scopes.every((scope) => scope.configStore.getState().config !== null)).toBe(true);
    scopes.forEach((scope) => scope.dispose());
    // Disposal removes listeners; a retired view is not re-populated or notified.
    scopes[0].modelsStore.setState({ models: [{ name: 'detached' }] });
    notifySourceConfigChanged(a.session.owner);
    expect(scopes[0].modelsStore.getState().models).toEqual([{ name: 'detached' }]);
  });

  test('model discovery after lease replay does not reuse the retired in-flight request', async () => {
    const a = fixture('a');
    const scope = createProviderSourceScope(a.session, a.source);
    const pending = deferred<unknown>();
    let count = 0;
    a.onPost(async () =>
      ++count === 1 ? pending.promise : { status_code: 200, body: { data: [{ id: 'new' }] } }
    );
    const old = scope.modelsApi.fetchClaudeModelsViaApiCall('https://upstream.invalid', 'key');
    scope.dispose();
    scope.activate();
    const next = await scope.modelsApi.fetchClaudeModelsViaApiCall(
      'https://upstream.invalid',
      'key'
    );
    expect(next.map((model) => model.name)).toEqual(['new']);
    pending.resolve({ status_code: 200, body: { data: [{ id: 'old' }] } });
    await expect(old).rejects.toThrow();
    expect(count).toBe(2);
    scope.dispose();
  });

  test('catalog freezes its view signal so lease replay cannot publish the old result', async () => {
    const a = fixture('a');
    const scope = createProviderSourceScope(a.session, a.source);
    const pending = deferred<{ data: unknown }>();
    const http = spyOn(axios, 'get').mockImplementation(() => pending.promise);
    restores.push(() => http.mockRestore());
    const result = scope.modelsApi.fetchModels(a.source.apiBase);
    while (http.mock.calls.length === 0) await Promise.resolve();
    scope.dispose();
    scope.activate();
    pending.resolve({ data: { data: [{ id: 'old' }] } });
    await expect(result).rejects.toThrow();
    scope.dispose();
  });

  test('malformed client-key inventories reject instead of supplying catalog credentials', async () => {
    const a = fixture('a');
    a.onGet(async () => ({ keys: ['not-a-config-list'] }));
    await expect(createApiKeysApi(a.session).list()).rejects.toThrow(
      'Invalid client API key inventory'
    );
  });

  test('the inventory validator remains a pure dependency without auth/store initialization', () => {
    const code = readFileSync('src/services/api/providerInventory.ts', 'utf8');
    expect(code).not.toMatch(/from ['"][^'"]*(?:stores|client|providers|config)['"]/);
    const config = readFileSync('src/services/api/config.ts', 'utf8');
    expect(config).toContain("from './providerInventory'");
    expect(config).not.toContain("from './providers'");
  });

  test('provider UI request chains cannot import ambient API objects or stores', () => {
    for (const path of [
      'src/features/providers/useProviderWorkbench.ts',
      'src/features/providers/sheets/forms/useConnectivityTest.ts',
      'src/features/providers/sheets/forms/useModelDiscovery.ts',
      'src/features/providers/sheets/forms/useSponsorUsageCheck.ts',
    ]) {
      const code = readFileSync(path, 'utf8');
      expect(code).not.toMatch(
        /import\s*\{[^}]*\b(?:apiClient|providersApi|modelsApi|apiCallApi|useAuthStore|useConfigStore)\b[^}]*\}\s*from/
      );
      expect(code).toContain('useProviderSource');
    }
  });
});
