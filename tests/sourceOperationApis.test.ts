import { afterEach, expect, spyOn, test } from 'bun:test';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '../src/services/api/client';
import { SourceSessions } from '../src/services/api/sourceSession';
import { createOAuthApi, captureSiwcBindingApi } from '../src/services/api/oauth';
import { createLogsApi, responseDataToText } from '../src/services/api/logs';
import { createConfigFileApi } from '../src/services/api/configFile';
import { createConfigPatchApi, buildConfigPatch } from '../src/services/api/configPatch';
import { createVertexApi } from '../src/services/api/vertex';
import { createConfigApi } from '../src/services/api/config';
import { createSiwcStart } from '../src/features/oauth/siwcBinding';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));
const connections = ['alpha', 'beta'].map((instanceId) => ({
  instanceId,
  apiBase: `https://${instanceId}.invalid`,
  managementKey: `synthetic-${instanceId}`,
  configurationRevision: '1',
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(respond: (config: InternalAxiosRequestConfig) => unknown | Promise<unknown>) {
  const calls: InternalAxiosRequestConfig[] = [];
  const sessions = new SourceSessions();
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    return { data: await respond(config), status: 200, statusText: 'OK', headers: {}, config };
  };
  const configure = (configs = connections) => {
    const previous = axios.defaults.adapter;
    axios.defaults.adapter = adapter;
    try {
      sessions.configure(configs);
    } finally {
      axios.defaults.adapter = previous;
    }
  };
  const adapter = axios.defaults.adapter;
  try {
    sessions.configure(connections);
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
  for (const method of [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'getRaw',
    'postForm',
    'captureConnection',
    'getConnectionRevision',
  ] as const) {
    spies.push(
      spyOn(apiClient, method).mockImplementation(() => {
        throw new Error(`Ambient ${method}`);
      })
    );
  }
  return { sessions, calls, configure };
}
function expectOwner(calls: InternalAxiosRequestConfig[], id: string) {
  for (const call of calls) {
    expect(call.baseURL).toBe(`https://${id}.invalid/v8/management`);
    expect(call.headers.Authorization).toBe(`Bearer synthetic-${id}`);
  }
}

test('OAuth start, polling, callback and cancellation retain their original source', async () => {
  const { sessions, calls } = fixture((config) =>
    config.url === '/oauth/auth-url'
      ? { url: 'https://login.invalid', state: 'same-state' }
      : { status: 'ok', cancelled: true }
  );
  const a = createOAuthApi(sessions.captureSource('alpha'));
  const b = createOAuthApi(sessions.captureSource('beta'));
  await a.startAuth('anthropic');
  expect(calls[0].params).toEqual({ provider: 'claude', is_webui: true });
  await b.startAuth('codex');
  await a.getAuthStatus('same-state');
  await a.submitCallback('anthropic', 'http://localhost/callback?state=same-state');
  await a.cancelSession('same-state');
  expectOwner([calls[0], ...calls.slice(2)], 'alpha');
  expectOwner([calls[1]], 'beta');
});

test('log cursors, clear and both download routes remain source-local', async () => {
  const { sessions, calls } = fixture((config) => {
    if (config.responseType === 'blob') return new Blob([config.baseURL!]);
    if (config.url?.endsWith('/errors')) return { files: [{ name: 'same.log', size: 12 }] };
    return { lines: ['same line'], 'next-cursor': 'same-cursor', 'latest-timestamp': 12 };
  });
  for (const id of ['alpha', 'beta']) {
    const api = createLogsApi(sessions.captureSource(id));
    const start = calls.length;
    const page = await api.fetchLogs();
    await api.fetchLogs({ cursor: page.nextCursor });
    expect(calls.at(-1)?.params).toEqual({ cursor: 'same-cursor' });
    expect((await api.fetchErrorLogs()).files[0].name).toBe('same.log');
    const file = await api.downloadErrorLog('same.log');
    expect(await responseDataToText(file.data)).toContain(id);
    await api.downloadRequestLogById('same-id');
    await api.clearLogs();
    expectOwner(calls.slice(start), id);
  }
});

test('config preview, multi-step mutation and reconciliation use the captured source', async () => {
  const original = 'server:\n  port: 8080\n  host: localhost\n';
  const next = 'server:\n  port: 9090\n';
  const { sessions, calls } = fixture((config) => (config.url === '/config.yaml' ? original : {}));
  const a = sessions.captureSource('alpha');
  const document = createConfigFileApi(a);
  const before = await document.fetchConfigYaml();
  await createConfigFileApi(sessions.captureSource('beta')).fetchConfigYaml();
  await createConfigPatchApi(a).applyConfigPatch(buildConfigPatch(before, next));
  await document.fetchConfigYaml();
  await document.saveConfigYaml(next);
  expectOwner([calls[0], ...calls.slice(2)], 'alpha');
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    ['get', '/config.yaml'],
    ['get', '/config.yaml'],
    ['patch', '/config'],
    ['delete', '/config/server/host'],
    ['get', '/config.yaml'],
    ['put', '/config.yaml'],
  ]);
});

test('ABA invalidation rejects delayed callbacks, downloads and saves without fallback', async () => {
  const { sessions, calls, configure } = fixture(() => ({}));
  const a = sessions.captureSource('alpha');
  const oauth = createOAuthApi(a);
  const logs = createLogsApi(a);
  const document = createConfigFileApi(a);
  const patch = createConfigPatchApi(a);
  configure([{ ...connections[0], configurationRevision: '2' }, connections[1]]);
  configure();
  for (const operation of [
    () => oauth.startAuth('codex'),
    () => oauth.getAuthStatus('s'),
    () => oauth.submitCallback('codex', 'http://localhost/callback'),
    () => oauth.cancelSession('s'),
    () => logs.fetchLogs(),
    () => logs.clearLogs(),
    () => logs.downloadErrorLog('same.log'),
    () => logs.downloadRequestLogById('same-id'),
    () => document.fetchConfigYaml(),
    () => document.saveConfigYaml('server: {}'),
    () => patch.applyConfigPatch({ patch: { server: { port: 9090 } }, deletions: [] }),
    () => captureSiwcBindingApi(a).cancel('s'),
  ])
    await expect(operation()).rejects.toThrow();
  expect(calls).toHaveLength(0);
  await createOAuthApi(sessions.captureSource('alpha')).startAuth('codex');
  expect(calls).toHaveLength(1);
});

test('invalidation during a patch prevents subsequent deletes and stale readback', async () => {
  const dispatched = deferred();
  const release = deferred();
  const { sessions, calls, configure } = fixture(async () => {
    dispatched.resolve();
    await release.promise;
    return {};
  });
  const a = sessions.captureSource('alpha');
  const save = createConfigPatchApi(a).applyConfigPatch({
    patch: { server: { port: 9090 } },
    deletions: [['server', 'host']],
  });
  await dispatched.promise;
  configure([connections[1]]);
  release.resolve();
  await expect(save).rejects.toThrow('Source session changed');
  expect(calls).toHaveLength(1);
  await expect(createConfigFileApi(a).fetchConfigYaml()).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test('partial patch failure permits reconciliation only under the original live owner', async () => {
  const { sessions, calls } = fixture((config) => {
    if (config.method === 'delete') throw new Error('Synthetic interrupted mutation');
    return config.url === '/config.yaml' ? 'server:\n  port: 9090\n' : {};
  });
  const a = sessions.captureSource('alpha');
  await expect(
    createConfigPatchApi(a).applyConfigPatch({
      patch: { server: { port: 9090 } },
      deletions: [['server', 'host']],
    })
  ).rejects.toThrow('Synthetic interrupted mutation');
  expect(await createConfigFileApi(a).fetchConfigYaml()).toContain('9090');
  expectOwner(calls, 'alpha');
});

test('SIWC close during startup cancels its late state on A after work starts on B', async () => {
  const dispatched = deferred();
  const release = deferred();
  const cancelled = deferred();
  const { sessions, calls } = fixture(async (config) => {
    if (config.url === '/oauth/siwc/bind') {
      dispatched.resolve();
      await release.promise;
      return { state: 'late-state', status: 'ok', flow: 'siwc_bind' };
    }
    if (config.method === 'delete') cancelled.resolve();
    return { status: 'ok' };
  });
  const captured = captureSiwcBindingApi(sessions.captureSource('alpha'));
  const startup = createSiwcStart({
    start: () => captured.start('same.json'),
    cancel: captured.cancel,
    onResult: () => {
      throw new Error('Closed SIWC published');
    },
    onError: () => {
      throw new Error('Closed SIWC published failure');
    },
  });
  const pending = startup.start();
  await dispatched.promise;
  startup.close();
  await createOAuthApi(sessions.captureSource('beta')).startAuth('codex');
  release.resolve();
  await pending;
  await cancelled.promise;
  expectOwner([calls[0], calls[2]], 'alpha');
  expect(calls[2].params).toEqual({ state: 'late-state' });
});

test('all config field paths are validated before any mutation is dispatched', async () => {
  const { sessions, calls } = fixture(() => ({}));
  const patch = createConfigPatchApi(sessions.captureSource('alpha'));
  await expect(
    patch.applyConfigPatch({ patch: { server: {} }, deletions: [['..']] })
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test('late OAuth, log download and config read responses reject after source replacement', async () => {
  for (const kind of ['oauth', 'logs', 'config'] as const) {
    const dispatched = deferred();
    const release = deferred();
    const { sessions, configure } = fixture(async () => {
      dispatched.resolve();
      await release.promise;
      return kind === 'logs' ? new Blob(['old-source']) : 'old-source';
    });
    const a = sessions.captureSource('alpha');
    const pending =
      kind === 'oauth'
        ? createOAuthApi(a).getAuthStatus('same-state')
        : kind === 'logs'
          ? createLogsApi(a).downloadErrorLog('same.log')
          : createConfigFileApi(a).fetchConfigYaml();
    await dispatched.promise;
    configure([{ ...connections[0], configurationRevision: '2' }, connections[1]]);
    release.resolve();
    await expect(pending).rejects.toThrow();
    spies.splice(0).forEach((spy) => spy.mockRestore());
  }
});

test('Vertex uploads preserve multipart fields and source ownership', async () => {
  const { sessions, calls, configure } = fixture(() => ({ status: 'ok', project_id: 'fixture' }));
  const a = sessions.captureSource('alpha');
  const upload = createVertexApi(a);
  const file = new File(['{}'], 'fixture.json', { type: 'application/json' });
  await upload.importCredential(file, 'us-central1');
  await createVertexApi(sessions.captureSource('beta')).importCredential(file);
  expectOwner([calls[0]], 'alpha');
  expectOwner([calls[1]], 'beta');
  expect(calls[0].url).toBe('/oauth/import?provider=vertex');
  const data = calls[0].data as FormData;
  expect(data.get('location')).toBe('us-central1');
  expect((data.get('file') as File).name).toBe('fixture.json');
  expect((calls[1].data as FormData).has('location')).toBe(false);
  configure([connections[1]]);
  await expect(upload.importCredential(file)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

test('Logs settings normalize independently for each destination', async () => {
  const { sessions, calls } = fixture((config) => ({
    observability: {
      logs: {
        'logging-to-file': config.baseURL?.includes('alpha'),
        'request-log': config.baseURL?.includes('beta'),
      },
    },
  }));
  const a = await createConfigApi(sessions.captureSource('alpha')).getConfig();
  const b = await createConfigApi(sessions.captureSource('beta')).getConfig();
  expect(a).toMatchObject({ loggingToFile: true, requestLog: false });
  expect(b).toMatchObject({ loggingToFile: false, requestLog: true });
  expectOwner([calls[0]], 'alpha');
  expectOwner([calls[1]], 'beta');
});
