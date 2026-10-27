import { afterEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import type { TFunction } from 'i18next';
import { createQuotaAdapters, QUOTA_ADAPTERS } from '@/features/quota/providers';
import { createAuthFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import { apiCallApi, type ApiCallRequest } from '@/services/api/apiCall';
import {
  SourceSessions,
  sourceResourceKey,
  type SourceSession,
} from '@/services/api/sourceSession';
import { createQuotaStore } from '@/stores/useQuotaStore';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  CODEX_USAGE_URL,
  CODEX_SUBSCRIPTION_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  XAI_API_CHAT_URL,
  XAI_API_ME_URL,
} from '@/utils/quota';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as TFunction;
const file: AuthFileItem = { name: 'same.json', authIndex: '007' };
const connections = ['alpha', 'beta'].map((instanceId) => ({
  instanceId,
  apiBase: `https://quota-fixture.invalid/${instanceId}`,
  managementKey: `synthetic-${instanceId}`,
  configurationRevision: '1',
}));
const envelope = (body: unknown, status_code = 200) => ({ status_code, header: {}, body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Call {
  owner: string;
  path: string;
  payload: ApiCallRequest & Record<string, unknown>;
}
function fixture(respond: (call: Call) => unknown | Promise<unknown>) {
  const sessions = new SourceSessions();
  sessions.configure(connections);
  const calls: Call[] = [];
  function capture(id: string): SourceSession {
    const session = sessions.captureSource(id);
    const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
      expect(config.baseURL).toBe(`https://quota-fixture.invalid/${id}/v8/management`);
      expect(config.headers.Authorization).toBe(`Bearer synthetic-${id}`);
      const call: Call = {
        owner: id,
        path: config.url!,
        payload: typeof config.data === 'string' ? JSON.parse(config.data) : (config.data ?? {}),
      };
      calls.push(call);
      return { data: await respond(call), status: 200, statusText: 'OK', headers: {}, config };
    };
    // Inject an in-memory Axios adapter into the real source transport. No network.
    return {
      ...session,
      management: {
        ...session.management,
        get: (path, config) => session.management.get(path, { ...config, adapter }),
        post: (path, data, config) => session.management.post(path, data, { ...config, adapter }),
        getRaw: (path, config) => session.management.getRaw(path, { ...config, adapter }),
      },
    };
  }
  return { sessions, calls, capture };
}
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
});
function forbidSingleton() {
  for (const method of ['get', 'post', 'getRaw'] as const) {
    spies.push(
      spyOn(apiClient, method).mockImplementation(() => {
        throw new Error('ambient singleton escape');
      })
    );
  }
}

test('factory and source inventory enumeration are passive for every quota provider', async () => {
  forbidSingleton();
  const f = fixture(() => ({
    files: [
      { ...file, provider: 'xai' },
      { ...file, name: 'meta.json', provider: 'meta' },
    ],
  }));
  for (const id of ['alpha', 'beta']) {
    const session = f.capture(id);
    const adapters = createQuotaAdapters(session);
    expect(Object.keys(adapters)).toEqual(Object.keys(QUOTA_ADAPTERS));
    expect(f.calls.every((call) => call.path === '/credentials')).toBe(true);
    await createAuthFilesApi(session).list();
  }
  expect(f.calls.map((call) => call.path)).toEqual(['/credentials', '/credentials']);
  const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
  expect(page).toContain('useProviderSources()');
  expect(page).not.toContain('useDevinQuotaAutoLoad(');
});

test('identical Meta identities retain owner keys, secrets, numerical values, and isolated stores', async () => {
  forbidSingleton();
  const f = fixture(({ path, owner, payload }) => {
    if (path.includes('/credentials/download'))
      return new Blob([
        JSON.stringify({ dca_token: `dca:${owner}`, api_key: 'unused-secret-sentinel' }),
      ]);
    expect(payload.authIndex).toBe('007');
    expect(JSON.stringify(payload)).toContain(`dca:${owner}`);
    expect(JSON.stringify(payload)).not.toContain('unused-secret-sentinel');
    return envelope({ subs_usage: { weekly: { used_percent: owner === 'alpha' ? 17.25 : 62.5 } } });
  });
  const a = f.capture('alpha'),
    b = f.capture('beta');
  const storeA = createQuotaStore(),
    storeB = createQuotaStore();
  const adaptersA = createQuotaAdapters(a, storeA),
    adaptersB = createQuotaAdapters(b, storeB);
  const [dataA, dataB] = await Promise.all([
    adaptersA.meta.fetchQuota(file, t),
    adaptersB.meta.fetchQuota(file, t),
  ]);
  expect(JSON.stringify(dataA)).not.toContain('dca:');
  expect(JSON.stringify(dataB)).not.toContain('unused-secret-sentinel');
  expect(dataA).not.toEqual(dataB);
  const key = getQuotaCacheKey(file);
  expect(sourceResourceKey(a.owner, key)).not.toBe(sourceResourceKey(b.owner, key));
  storeA.getState().setMetaQuota({ [key]: adaptersA.meta.buildSuccessState(dataA) });
  storeB.getState().setMetaQuota({ [key]: adaptersB.meta.buildSuccessState(dataB) });
  storeA.getState().clearQuotaCache([file.name]);
  expect(storeA.getState().metaQuota[key]).toBeUndefined();
  expect(storeB.getState().metaQuota[key]).toEqual(adaptersB.meta.buildSuccessState(dataB));
  expect(f.calls.filter((call) => call.path === '/requests/api-call')).toHaveLength(2);
});

test('stale credential download cannot dispatch a nested API call against either source', async () => {
  forbidSingleton();
  const started = deferred<void>(),
    release = deferred<Blob>();
  const f = fixture(() => {
    started.resolve();
    return release.promise;
  });
  const adapter = createQuotaAdapters(f.capture('alpha')).meta;
  const pending = adapter.fetchQuota(file, t);
  const outcome = pending.then(
    () => 'success',
    () => 'stale'
  );
  await started.promise;
  f.sessions.configure([connections[1]]);
  release.resolve(new Blob([JSON.stringify({ dca_token: 'dca:alpha' })]));
  expect(await outcome).toBe('stale');
  expect(f.calls).toHaveLength(1);
});

test('Kimi download and allowed quota domain remain bound to the requested owner', async () => {
  forbidSingleton();
  const f = fixture(({ path, owner, payload }) => {
    if (path.includes('/credentials/download'))
      return new Blob([
        JSON.stringify({ domain: owner === 'alpha' ? 'ai' : 'com', access_token: 'never-publish' }),
      ]);
    expect(payload.url).toContain(owner === 'alpha' ? 'kimi.ai' : 'kimi.com');
    expect(JSON.stringify(payload)).not.toContain('never-publish');
    return envelope({ limits: [] });
  });
  await Promise.all(
    ['alpha', 'beta'].map((id) => createQuotaAdapters(f.capture(id)).kimi.fetchQuota(file, t))
  );
  expect(f.calls).toHaveLength(4);
});

const codexUsage = {
  plan_type: 'pro',
  credits: { balance: '012.50', unlimited: false },
  rate_limit: {
    primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1800000000 },
  },
};
function codexResponse({ path, payload }: Call) {
  if (path === '/routing/cooldown/reset') return { status: 'ok', auth_index: '007', models: [] };
  if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL)
    return envelope({ code: 'reset' });
  if (payload.url === CODEX_USAGE_URL) return envelope(codexUsage);
  if (payload.url.startsWith(CODEX_SUBSCRIPTION_URL)) return envelope({ active_until: 1800000000 });
  if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL)
    return envelope({ available_count: 2, credits: [] });
  throw new Error('Unexpected synthetic request');
}

test('Codex reset, cooldown, quota and subscription metadata stay on captured A while B exists', async () => {
  forbidSingleton();
  const f = fixture(codexResponse);
  const a = createQuotaAdapters(f.capture('alpha')).codex;
  const target = { ...file, id_token: { chatgpt_account_id: 'same-account' } };
  const data = await a.resetQuota!(target, t);
  expect(f.calls.every((call) => call.owner === 'alpha')).toBe(true);
  expect(f.calls[0].payload.url).toBe(CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL);
  expect(f.calls[1].path).toBe('/routing/cooldown/reset');
  expect(f.calls.some((call) => call.payload.url?.startsWith(CODEX_SUBSCRIPTION_URL))).toBe(true);
  const request = spyOn(apiCallApi, 'request').mockImplementation(async (payload) => {
    const raw = codexResponse({
      path: '/requests/api-call',
      payload,
      owner: 'legacy',
    }) as ReturnType<typeof envelope>;
    return {
      statusCode: raw.status_code,
      header: {},
      body: raw.body,
      bodyText: JSON.stringify(raw.body),
    };
  });
  spies.push(request);
  const legacy = await QUOTA_ADAPTERS.codex.fetchQuota(target, t);
  expect(data).toEqual(legacy);
});

test('stale reset confirmation and stale redemption response cannot clear another source cooldown', async () => {
  forbidSingleton();
  const started = deferred<void>(),
    release = deferred<unknown>();
  const f = fixture(() => {
    started.resolve();
    return release.promise;
  });
  const a = createQuotaAdapters(f.capture('alpha')).codex;
  const outcome = a.resetQuota!(file, t).then(
    () => 'success',
    () => 'stale'
  );
  await started.promise;
  f.sessions.configure([connections[1]]);
  release.resolve(envelope({ code: 'reset' }));
  expect(await outcome).toBe('stale');
  await expect(a.resetQuota!(file, t)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

test('plugin fallback list/cache and nested quota route cannot mix identical provider indices', async () => {
  forbidSingleton();
  const f = fixture(({ owner, path, payload }) => {
    if (path === '/plugins')
      return {
        plugins: [
          {
            id: `${owner}-quota`,
            registered: true,
            supports_quota: true,
            quota_provider: 'custom',
          },
        ],
      };
    expect(path).toBe(`/plugins/${owner}-quota/quota`);
    expect(payload.auth_index).toBe('007');
    return {
      groups: [],
      summary: [{ key: 'balance', label: 'Balance', value: owner === 'alpha' ? 1.25 : 9.5 }],
    };
  });
  const a = createQuotaAdapters(f.capture('alpha')),
    b = createQuotaAdapters(f.capture('beta'));
  const target = { ...file, quotaProvider: 'custom' };
  const [dataA, dataB] = await Promise.all([
    a.plugin.fetchQuota(target, t),
    b.plugin.fetchQuota(target, t),
  ]);
  expect(dataA).not.toEqual(dataB);
  await a.plugin.fetchQuota(target, t);
  expect(f.calls.filter((call) => call.path === '/plugins')).toHaveLength(2);
});

test('Antigravity project download and subscription metadata retain owner', async () => {
  forbidSingleton();
  const f = fixture(({ path, owner, payload }) => {
    if (path.includes('/credentials/download'))
      return new Blob([JSON.stringify({ project_id: `${owner}-project` })]);
    if (payload.url.includes('loadCodeAssist'))
      return envelope({ currentTier: { id: 'g1-pro-tier', name: 'Pro' } });
    expect(payload.data).toContain(`${owner}-project`);
    return envelope({ groups: [] });
  });
  await Promise.all(
    ['alpha', 'beta'].map((id) =>
      createQuotaAdapters(f.capture(id)).antigravity.fetchQuota(file, t)
    )
  );
  expect(f.calls.filter((call) => call.payload.url?.includes('loadCodeAssist'))).toHaveLength(2);
});

test('xAI fallback inference and optional metadata run only explicitly and retain owner', async () => {
  forbidSingleton();
  const f = fixture(({ payload }) => {
    if (payload.url === XAI_API_CHAT_URL) return envelope({ choices: [] });
    if (payload.url === XAI_API_ME_URL) return envelope({ user_id: 'same-user' });
    return envelope({}, 403);
  });
  const a = createQuotaAdapters(f.capture('alpha')).xai;
  expect(f.calls).toHaveLength(0);
  const data = await a.fetchQuota(file, t);
  await a.enrichQuota!(file, data, t);
  expect(f.calls.some((call) => call.payload.url === XAI_API_CHAT_URL)).toBe(true);
  expect(f.calls.every((call) => call.owner === 'alpha')).toBe(true);
  f.sessions.configure([connections[1]]);
  const count = f.calls.length;
  await expect(a.enrichQuota!(file, data, t)).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
});

test('Claude grant reads, preflight and claim have owner-local journals and stale action guards', async () => {
  forbidSingleton();
  const organization = '11111111-2222-3333-4444-555555555555';
  const f = fixture(({ payload }) => {
    if (payload.url.endsWith('/profile')) return envelope({ organization: { uuid: organization } });
    if (payload.method === 'POST') return envelope({ result: 'reset' });
    return envelope({
      cedar_ember: {
        eligible: true,
        at_limit: true,
        grants: [{ id: 'same-grant', resets_total: 2, resets_left: 2, usable_now: true }],
      },
    });
  });
  const a = createQuotaAdapters(f.capture('alpha')).claude.resetGrants!;
  const b = createQuotaAdapters(f.capture('beta')).claude.resetGrants!;
  await Promise.all([a.read('007'), b.read('007')]);
  await a.operations.run('same-key', '007', 'same-grant');
  expect(a.operations.inspect('same-key')?.code).toBe('reset');
  expect(b.operations.inspect('same-key')).toBeUndefined();
  expect(
    f.calls.filter((call) => call.payload.method === 'POST').map((call) => call.owner)
  ).toEqual(['alpha']);
  f.sessions.configure([connections[1]]);
  const count = f.calls.length;
  await expect(a.operations.run('same-key', '007', 'same-grant')).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
});

test('Devin queued work checks original source before dequeue and never dispatches the fourth job', async () => {
  forbidSingleton();
  const release = deferred<unknown>(),
    started = deferred<void>();
  let count = 0;
  const f = fixture(() => {
    if (++count === 3) started.resolve();
    return release.promise;
  });
  const adapter = createQuotaAdapters(f.capture('alpha')).devin;
  const outcomes = Promise.allSettled(
    [0, 1, 2, 3].map((index) => adapter.fetchQuota({ ...file, name: `${index}.json` }, t))
  );
  await started.promise;
  f.sessions.configure([connections[1]]);
  release.resolve(envelope({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 40 } } }));
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  expect(f.calls).toHaveLength(3);
});

test('provider implementations obtain request dependencies only through injection', () => {
  for (const provider of Object.keys(QUOTA_ADAPTERS)) {
    const source = readFileSync(`src/features/quota/providers/${provider}/data.ts`, 'utf8');
    const imports = source.match(/import[\s\S]*?from\s+['"][^'"]+['"];?/g) ?? [];
    for (const statement of imports) {
      expect(statement).not.toMatch(/\b(apiClient|authFilesApi|apiCallApi|pluginsApi)\b/);
    }
  }
});

test('Claude usage/profile reads keep A/B ownership and reject stale optional metadata', async () => {
  forbidSingleton();
  const profileStarted = deferred<void>();
  const releaseProfile = deferred<unknown>();
  const f = fixture(({ owner, payload }) => {
    if (payload.url.endsWith('/profile')) {
      if (owner === 'alpha') {
        profileStarted.resolve();
        return releaseProfile.promise;
      }
      return envelope({ account: { has_claude_pro: true } });
    }
    return envelope({
      five_hour: { utilization: owner === 'alpha' ? 25 : 50, resets_at: '2030-01-01T00:00:00Z' },
    });
  });
  const a = createQuotaAdapters(f.capture('alpha')).claude;
  const b = createQuotaAdapters(f.capture('beta')).claude;
  const outcome = a.fetchQuota(file, t).then(
    () => 'success',
    () => 'stale'
  );
  await profileStarted.promise;
  const dataB = await b.fetchQuota(file, t);
  expect(b.buildSuccessState(dataB).status).toBe('success');
  f.sessions.configure([connections[1]]);
  releaseProfile.resolve(envelope({ account: { has_claude_max: true } }));
  expect(await outcome).toBe('stale');
  expect(f.calls.filter((call) => call.owner === 'alpha')).toHaveLength(2);
  expect(f.calls.filter((call) => call.owner === 'beta')).toHaveLength(2);
});

test('retiring source during grant preflight prevents status and spending dispatch', async () => {
  forbidSingleton();
  const started = deferred<void>(),
    release = deferred<unknown>();
  const f = fixture(() => {
    started.resolve();
    return release.promise;
  });
  const scope = createQuotaAdapters(f.capture('alpha')).claude.resetGrants!;
  const outcome = scope.operations.run('same-key', '007', 'same-grant').then(
    () => 'success',
    () => 'stale'
  );
  await started.promise;
  f.sessions.configure([connections[1]]);
  release.resolve(envelope({ organization: { uuid: '11111111-2222-3333-4444-555555555555' } }));
  expect(await outcome).toBe('stale');
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].payload.method).toBe('GET');
});
