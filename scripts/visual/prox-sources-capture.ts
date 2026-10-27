/** Browser-only synthetic bootstrap, served by Vite; never imported by the application. */
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.scss';

type RequestRecord = {
  route: string; phase: string; source: string; method: string; path: string;
  forbidden: boolean; unexpected?: boolean; targets?: string[];
};
const smoke = {
  phase: 'passive', requests: [] as RequestRecord[], unauthorized: [] as string[], ready: false,
};
Object.assign(window, { __sourceSmoke: smoke });
const discovery = {
  schemaVersion: 1, revision: 'a'.repeat(64), defaultInstanceId: 'alpha',
  sources: [
    { instanceId: 'alpha', label: 'Alpha fixture', publicBasePath: '/alpha', aliases: [''], authScope: 'fixture' },
    { instanceId: 'beta', label: 'Beta fixture', publicBasePath: '/beta', aliases: [], authScope: 'fixture' },
  ],
};
const yaml = 'server:\n  port: 8317\nobservability:\n  logs:\n    logging-to-file: true\n    request-log: false\n';
const config = (source: string) => ({
  server: { port: 8317 },
  access: { 'api-keys': [] },
  observability: { logs: { 'logging-to-file': true, 'request-log': false } },
  'api-keys': {
    [source === 'beta' ? 'claude' : 'codex']: [{
      name: `${source} synthetic provider`, keys: [{ 'api-key': `synthetic-${source}-not-a-credential` }],
      models: [{ name: 'fixture-model', alias: 'fixture-model' }],
    }],
  },
});
const inventory = (source: string) => ({ files: [{
  name: 'same.json', type: source === 'beta' ? 'claude' : 'codex', auth_index: 'fixture-index',
  email: `${source}@example.invalid`, disabled: false, status: 'ready', size: 128,
  account: 'FIXTURE_ACCOUNT_MUST_NOT_RENDER',
}] });
const plugin = { id: 'fixture-plugin', configured: true, registered: true, enabled: true,
  effective_enabled: true, metadata: { name: 'Synthetic plugin', version: '1.0.0', author: 'Fixture' }, menus: [] };

function fail(config: InternalAxiosRequestConfig, status: number, message: string): never {
  throw new AxiosError(message, 'ERR_BAD_RESPONSE', config, undefined, {
    status, statusText: message, data: { error: message }, headers: {}, config,
  });
}
// Installed BEFORE importing any application API client, so axios.create copies this adapter.
axios.defaults.adapter = async (request) => {
  const rawUrl = request.url ?? '';
  const url = new URL(/^https?:/.test(rawUrl) ? rawUrl : `${request.baseURL || location.origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`);
  const source = url.pathname.startsWith('/beta/') ? 'beta' : url.pathname.startsWith('/alpha/') ? 'alpha' : 'ambient';
  const path = url.pathname.replace(/^\/(?:alpha|beta)/, '').replace(/^\/v8\/management/, '');
  const method = request.method ?? 'get';
  const sensitive = /api-call|download|refresh|reset|completions|generateContent|inference/.test(path);
  const entry: RequestRecord = { route: location.hash, phase: smoke.phase, source, method, path,
    forbidden: smoke.phase === 'passive' && (sensitive || method !== 'get') };
  smoke.requests.push(entry);
  if (entry.forbidden) fail(request, 409, 'Blocked passive operation');
  if (url.origin !== location.origin) { entry.unexpected = true; fail(request, 403, 'External request blocked'); }
  if (smoke.unauthorized.includes(source)) fail(request, 401, 'Synthetic source unauthorized');
  let data: unknown;
  if (path === '/credentials' && method === 'get') data = inventory(source);
  else if (path === '/credentials' && method === 'delete') {
    const body = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
    const names = Array.isArray(body?.names) ? body.names : [];
    entry.targets = names.filter((name: unknown) => name === 'same.json');
    data = { status: 'ok', deleted: names.length, files: names, failed: [] };
  } else if (path === '/config') data = config(source);
  else if (path === '/config.yaml') data = yaml;
  else if (path === '/config/access/api-keys') data = [];
  else if (path === '/config/oauth/excluded-models') data = {};
  else if (path === '/config/oauth/model-alias') data = {};
  else if (path.startsWith('/routing/model-definitions/') || path.startsWith('/credentials/models')) data = { models: [{ id: 'fixture-model' }] };
  else if (path === '/observability/usage/api-keys') data = { providers: {} };
  else if (path === '/observability/logs') data = { lines: [`[2026-10-27 12:00:00] [info] ${source} synthetic log`], 'latest-timestamp': 1793102400 };
  else if (path === '/observability/logs/errors') data = { files: [] };
  else if (path === '/plugins') data = { plugins_enabled: true, plugins_dir: 'fixture-plugins', plugins: [plugin] };
  else if (path === '/plugins/store') data = { plugins: [{ id: 'fixture-store-plugin', store_id: 'fixture-store-plugin', name: 'Synthetic store entry', source_id: 'fixture', source_name: 'Fixture catalog', version: '1.0.0', description: 'Local synthetic catalog entry', installed: false }], source_errors: [] };
  else if (path === '/v1/models' || path === '/models') data = { data: [{ id: 'fixture-model', object: 'model' }] };
  else if (path === '/server/latest-version') data = { version: 'fixture-1.0.0' };
  else { entry.unexpected = true; fail(request, 501, `Missing synthetic response: ${method} ${path}`); }
  return { data, status: 200, statusText: 'OK', config: request,
    headers: { 'x-cpa-version': 'fixture-1.0.0', 'x-cpa-support-plugin': 'true' } };
};
window.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin === location.origin && url.pathname === '/prox/sources.json')
    return new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } });
  throw new Error(`Fixture blocked fetch: ${url.origin}${url.pathname}`);
};
const { useAuthStore } = await import('@/stores/useAuthStore');
const { providerSources } = await import('@/stores/useProviderSources');
Object.assign(smoke, { owners: () => providerSources.getSnapshot().sources.map(view => ({ id: view.source.instanceId, owner: view.session?.owner, status: view.status })) });
const { useLanguageStore } = await import('@/stores/useLanguageStore');
useLanguageStore.getState().setLanguage('en');
await useAuthStore.getState().login({ apiBase: location.origin, managementKey: 'synthetic-fixture-not-a-credential', rememberPassword: false });
await new Promise<void>((resolve) => {
  if (providerSources.getSnapshot().status !== 'loading') return resolve();
  const unsubscribe = providerSources.subscribe(() => {
    if (providerSources.getSnapshot().status !== 'loading') { unsubscribe(); resolve(); }
  });
});
const { default: App } = await import('@/App');
createRoot(document.getElementById('root')!).render(React.createElement(React.StrictMode, null, React.createElement(App)));
smoke.ready = true;
