import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { authFilesApi, createAuthFilesApi } from '../src/services/api/authFiles';
import { apiClient } from '../src/services/api/client';
import { createConfigValueApi } from '../src/services/api/configValue';
import { SourceSessions } from '../src/services/api/sourceSession';

const ALIASES = '/config/oauth/model-alias';
const EXCLUDED = '/config/oauth/excluded-models';
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  id: string,
  respond: (config: InternalAxiosRequestConfig) => unknown | Promise<unknown>
) {
  const calls: InternalAxiosRequestConfig[] = [];
  const sessions = new SourceSessions();
  const originalAdapter = axios.defaults.adapter;
  // Each real source transport copies this synthetic adapter at construction.
  // Restore the global default immediately; these tests never use a network adapter.
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    return {
      data: await respond(config),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  try {
    sessions.configure([
      {
        instanceId: id,
        configurationRevision: 'fixture',
        apiBase: `https://${id}.invalid`,
        managementKey: 'synthetic-test-key',
      },
    ]);
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
  const session = sessions.captureSource(id);
  return { calls, sessions, session, api: createAuthFilesApi(session) };
}

function forbidAmbientClient() {
  for (const method of [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'getRaw',
    'postForm',
    'getConnectionRevision',
  ] as const) {
    spies.push(
      spyOn(apiClient, method).mockImplementation(() => {
        throw new Error(`Scoped API used ambient ${method}`);
      })
    );
  }
}

function requestBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
  return JSON.parse(config.data as string);
}

describe('source-bound auth files', () => {
  test('all credential operations and nested helpers use the immutable source transport', async () => {
    forbidAmbientClient();
    for (const id of ['alpha', 'beta']) {
      const source = fixture(id, (config) => {
        if (config.url?.startsWith('/credentials/download')) return new Blob([id]);
        if (
          config.url?.startsWith('/credentials/models') ||
          config.url?.startsWith('/routing/model-definitions')
        ) {
          return { models: [{ id }] };
        }
        if (config.url === '/credentials' && config.method === 'get') {
          return { files: [{ name: 'same.json', weight: '3', auth_index: `${id}-index` }] };
        }
        if (config.url === '/credentials/refresh') {
          return { ok: true, results: [{ id, success: true, metadata: 'discard' }] };
        }
        return { status: 'ok' };
      });
      expect(Object.isFrozen(source.session.management)).toBe(true);
      expect('setConfig' in source.session.management).toBe(false);
      const { api, calls } = source;
      const listed = await api.list({ name: 'same.json', authIndex: `${id}-index` });
      expect(listed.files[0]).toMatchObject({
        name: 'same.json',
        weight: 3,
        authIndex: `${id}-index`,
      });
      expect(calls.at(-1)?.params).toEqual({ name: 'same.json', auth_index: `${id}-index` });
      await api.setStatus('same.json', true, `${id}-index`);
      expect(requestBody(calls.at(-1)!)).toEqual({
        name: 'same.json',
        disabled: true,
        auth_index: `${id}-index`,
      });
      await api.patchFields('same.json', { weight: 0, request_retry: null });
      expect(requestBody(calls.at(-1)!)).toEqual({
        name: 'same.json',
        weight: 0,
        request_retry: null,
      });
      expect(await api.requestManualRefresh('same.json', `${id}-index`)).toBeUndefined();
      expect(requestBody(calls.at(-1)!)).toEqual({ name: 'same.json', auth_index: `${id}-index` });
      expect(await api.requestAllManualRefresh()).toEqual([{ id, success: true }]);
      expect(calls.at(-1)?.timeout).toBe(300_000);
      expect(requestBody(calls.at(-1)!)).toEqual({ all: true });
      await api.resetCooldown(`${id}-index`);
      expect(requestBody(calls.at(-1)!)).toEqual({ auth_index: `${id}-index` });
      expect(await api.uploadFiles([new File(['{}'], 'same.json')])).toEqual({
        status: 'ok',
        uploaded: 1,
        files: ['same.json'],
        failed: [],
      });
      expect((calls.at(-1)?.data as FormData).getAll('file')).toHaveLength(1);
      expect(await api.deleteFiles([' same.json ', '', 'same.json'])).toEqual({
        status: 'ok',
        deleted: 1,
        files: ['same.json'],
        failed: [],
      });
      expect(requestBody(calls.at(-1)!)).toEqual({ names: ['same.json'] });
      expect(await api.deleteFile('same.json')).toMatchObject({ deleted: 1, files: ['same.json'] });
      expect(requestBody(calls.at(-1)!)).toEqual({ names: ['same.json'] });
      await api.deleteAll();
      expect(calls.at(-1)?.params).toEqual({ all: true });
      expect(await (await api.download('folder/same.json')).text()).toBe(id);
      expect(await api.downloadText('folder/same.json')).toBe(id);
      expect(calls.at(-1)?.url).toBe('/credentials/download?name=folder%2Fsame.json');
      expect(calls.at(-1)?.responseType).toBe('blob');
      expect(await api.getModelsForAuthFile('folder/same.json')).toEqual([{ id }]);
      expect(calls.at(-1)?.url).toBe('/credentials/models?name=folder%2Fsame.json');
      expect(await api.getModelDefinitions(' Grok ')).toEqual([{ id }]);
      expect(calls.at(-1)?.url).toBe('/routing/model-definitions/xai');
      for (const call of calls) {
        expect(call.baseURL).toBe(`https://${id}.invalid/v8/management`);
        expect(call.headers.Authorization).toBe('Bearer synthetic-test-key');
      }
    }
  });

  test('empty input guards avoid requests and partial batch failures retain normalization', async () => {
    const { api, calls } = fixture('batches', () => ({
      files: [' good.json ', 'good.json'],
      failed: [{ name: ' bad.json ', message: ' rejected ' }, { name: 'unknown.json' }, null],
    }));
    expect(await api.uploadFiles([])).toEqual({ status: 'ok', uploaded: 0, files: [], failed: [] });
    expect(await api.deleteFiles([' ', ''])).toEqual({
      status: 'ok',
      deleted: 0,
      files: [],
      failed: [],
    });
    expect(await api.getModelDefinitions(' ')).toEqual([]);
    expect(calls).toHaveLength(0);
    const expected = {
      status: 'partial',
      files: ['good.json'],
      failed: [
        { name: 'bad.json', error: 'rejected' },
        { name: 'unknown.json', error: 'Unknown error' },
      ],
    };
    expect(await api.uploadFiles([new File(['{}'], 'good.json')])).toEqual({
      ...expected,
      uploaded: 0,
    });
    expect(await api.deleteFiles(['good.json'])).toEqual({ ...expected, deleted: 0 });
  });

  test('OAuth reads, writes and deletes stay scoped and preserve normalization and unrelated fields', async () => {
    forbidAmbientClient();
    const stored: Record<string, unknown> = {
      [ALIASES]: {
        ' Grok ': [{ model: ' source ', alias: ' alias ', 'force-mapping': false }],
        gemini: [{ name: 'keep', alias: 'keep', future: true }],
      },
      [EXCLUDED]: { ' Grok ': 'one,ONE\ntwo', gemini: ['keep'] },
    };
    const { api } = fixture('oauth', (config) => {
      const path = config.url!;
      if (config.method === 'get') return structuredClone(stored[path]);
      stored[path] = requestBody(config);
      return {};
    });
    expect(await api.getOauthModelAlias()).toEqual({
      xai: [{ name: 'source', alias: 'alias', forceMapping: false }],
      gemini: [{ name: 'keep', alias: 'keep' }],
    });
    expect(await api.getOauthExcludedModels()).toEqual({ xai: ['one', 'two'], gemini: ['keep'] });
    await api.saveOauthModelAlias(' Grok ', [
      { name: ' new ', alias: ' alias ', forceMapping: false, fork: true },
      { name: 'duplicate', alias: 'ALIAS' },
    ]);
    expect(stored[ALIASES]).toEqual({
      xai: [{ name: 'new', alias: 'alias', 'force-mapping': false, fork: true }],
      gemini: [{ name: 'keep', alias: 'keep', future: true }],
    });
    await api.saveOauthExcludedModels(' Grok ', ['raw', 'RAW']);
    expect(stored[EXCLUDED]).toEqual({ xai: ['raw', 'RAW'], gemini: ['keep'] });
    await api.deleteOauthModelAlias('grok');
    expect(stored[ALIASES]).toEqual({ gemini: [{ name: 'keep', alias: 'keep', future: true }] });
    await api.deleteOauthExcludedEntry('grok');
    expect(stored[EXCLUDED]).toEqual({ gemini: ['keep'] });
    await api.replaceOauthExcludedModels({ ' Grok ': [' one ', 'ONE', 'two'] });
    expect(stored[EXCLUDED]).toEqual({ xai: ['one', 'two'] });
  });

  test.each([ALIASES, EXCLUDED])(
    'factories for one session share the write queue for %s',
    async (path) => {
      let stored: Record<string, unknown> = { gemini: ['untouched'] };
      const source = fixture('shared', (config) => {
        if (config.method === 'get') return structuredClone(stored);
        stored = requestBody(config);
        return {};
      });
      const other = createAuthFilesApi(source.session);
      if (path === ALIASES) {
        await Promise.all([
          source.api.saveOauthModelAlias('codex', [{ name: 'one', alias: 'one' }]),
          other.saveOauthModelAlias('claude', [{ name: 'two', alias: 'two' }]),
        ]);
        expect(stored).toEqual({
          gemini: ['untouched'],
          codex: [{ name: 'one', alias: 'one' }],
          claude: [{ name: 'two', alias: 'two' }],
        });
        await Promise.all([
          source.api.deleteOauthModelAlias('codex'),
          other.deleteOauthModelAlias('claude'),
        ]);
      } else {
        await Promise.all([
          source.api.saveOauthExcludedModels('codex', ['one']),
          other.saveOauthExcludedModels('claude', ['two']),
        ]);
        expect(stored).toEqual({ gemini: ['untouched'], codex: ['one'], claude: ['two'] });
        await Promise.all([
          source.api.deleteOauthExcludedEntry('codex'),
          other.deleteOauthExcludedEntry('claude'),
        ]);
      }
      expect(stored).toEqual({ gemini: ['untouched'] });
      expect(source.calls.map((call) => call.method)).toEqual([
        'get',
        'put',
        'get',
        'put',
        'get',
        'put',
        'get',
        'put',
      ]);
    }
  );

  test('replacement shares the queue; other sessions and OAuth paths can proceed independently', async () => {
    const started = deferred();
    const release = deferred();
    let stored: Record<string, unknown> = {};
    const first = fixture('same-owner', async (config) => {
      if (config.url === ALIASES) return {};
      if (config.method === 'get') return structuredClone(stored);
      if ('codex' in requestBody(config)) {
        started.resolve();
        await release.promise;
      }
      stored = requestBody(config);
      return {};
    });
    // Equal owner values must still have independent queues for distinct sessions.
    const second = fixture('same-owner', () => ({}));
    const initial = first.api.saveOauthExcludedModels('codex', ['one']);
    await started.promise;
    const replacement = createAuthFilesApi(first.session).replaceOauthExcludedModels({
      ' Claude ': [' two ', 'TWO'],
    });
    try {
      await second.api.saveOauthExcludedModels('gemini', ['three']);
      await first.api.saveOauthModelAlias('claude', [{ name: 'a', alias: 'b' }]);
      expect(first.calls.filter((call) => call.url === EXCLUDED)).toHaveLength(2);
      expect(second.calls.map((call) => call.method)).toEqual(['get', 'put']);
    } finally {
      release.resolve();
      await Promise.all([initial, replacement]);
    }
    expect(stored).toEqual({ claude: ['two'] });
  });

  test.each([ALIASES, EXCLUDED])(
    'a failed write releases the shared queue for %s',
    async (path) => {
      let fail = true;
      let stored: Record<string, unknown> = { codex: ['old'], claude: ['old'] };
      const source = fixture('recover', (config) => {
        if (config.method === 'get') return structuredClone(stored);
        if (fail) {
          fail = false;
          throw new Error('write failed');
        }
        stored = requestBody(config);
        return {};
      });
      const other = createAuthFilesApi(source.session);
      const results = await Promise.allSettled(
        path === ALIASES
          ? [source.api.deleteOauthModelAlias('codex'), other.deleteOauthModelAlias('claude')]
          : [source.api.deleteOauthExcludedEntry('codex'), other.deleteOauthExcludedEntry('claude')]
      );
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
      expect(stored).toEqual({ codex: ['old'] });
    }
  );

  test('invalidated sessions stop in-flight and queued writes before a dependent request', async () => {
    const started = deferred();
    const release = deferred();
    const source = fixture('stale', async () => {
      started.resolve();
      await release.promise;
      return {};
    });
    const other = createAuthFilesApi(source.session);
    const results = Promise.allSettled([
      source.api.saveOauthExcludedModels('codex', ['one']),
      other.saveOauthExcludedModels('claude', ['two']),
      other.replaceOauthExcludedModels({ gemini: ['three'] }),
    ]);
    await started.promise;
    source.sessions.reset();
    release.resolve();
    expect((await results).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(source.calls).toHaveLength(1);
    await expect(other.downloadText('same.json')).rejects.toThrow('Source session changed');
    await expect(other.deleteFile('same.json')).rejects.toThrow('Source session changed');
    expect(source.calls).toHaveLength(1);
  });

  test('rejects invalid providers and malformed config maps without writing', async () => {
    let payload: unknown = [];
    const { api, calls } = fixture('invalid', () => payload);
    await expect(api.saveOauthExcludedModels(' ', [])).rejects.toThrow('Invalid OAuth provider');
    await expect(api.saveOauthModelAlias(' ', [])).rejects.toThrow('Invalid OAuth provider');
    expect(calls).toHaveLength(0);
    for (payload of [[], 'bad', 4, false]) {
      await expect(api.deleteOauthExcludedEntry('codex')).rejects.toThrow(
        'Invalid OAuth configuration map'
      );
      await expect(api.deleteOauthModelAlias('codex')).rejects.toThrow(
        'Invalid OAuth configuration map'
      );
    }
    expect(calls.every((call) => call.method === 'get')).toBe(true);
  });

  test('config defaults only missing persisted values and propagates scoped transport errors', async () => {
    let failure = { status: 404, apiCode: 'not_found' };
    const source = fixture('errors', (config) => {
      throw {
        isAxiosError: true,
        message: 'fixture error',
        config,
        response: {
          status: failure.status,
          data: { error: { code: failure.apiCode, message: 'fixture error' } },
        },
      };
    });
    for (const read of [source.api.getOauthExcludedModels, source.api.getOauthModelAlias]) {
      failure = { status: 404, apiCode: 'not_found' };
      expect(await read()).toEqual({});
      for (failure of [
        { status: 404, apiCode: '' },
        { status: 401, apiCode: '' },
        { status: 500, apiCode: '' },
      ]) {
        await expect(read()).rejects.toMatchObject({ status: failure.status });
      }
    }
    const config = createConfigValueApi(
      source.session.management,
      () => () => source.session.assertCurrent()
    );
    const assertCurrent = config.guardConfigConnection();
    assertCurrent();
    source.sessions.reset();
    expect(assertCurrent).toThrow('Source session changed');
    await expect(config.getConfigValue(EXCLUDED, {})).rejects.toThrow('Source session changed');
  });

  test('compatibility nested helpers still dispatch through the exported facade', async () => {
    const remove = spyOn(authFilesApi, 'deleteFiles').mockResolvedValue({
      status: 'ok',
      deleted: 1,
      files: ['legacy.json'],
      failed: [],
    });
    const download = spyOn(authFilesApi, 'download').mockResolvedValue(new Blob(['legacy']));
    spies.push(remove, download);
    expect(await authFilesApi.deleteFile('legacy.json')).toMatchObject({ deleted: 1 });
    expect(remove).toHaveBeenCalledWith(['legacy.json']);
    expect(await authFilesApi.downloadText('legacy.json')).toBe('legacy');
    expect(download).toHaveBeenCalledWith('legacy.json');
  });
});

test('malformed and incomplete inventories fail without becoming empty accounts', async () => {
  for (const payload of [
    null,
    {},
    { files: null },
    { files: [null] },
    { files: [{}] },
    { files: [], has_more: true },
    { files: [], total: 1 },
    { files: [], page: 2 },
  ]) {
    const source = fixture('invalid', () => payload);
    await expect(source.api.list()).rejects.toThrow('Invalid credential inventory');
  }
  const empty = fixture('empty', () => ({ files: [], total: 0 }));
  expect((await empty.api.list()).files).toEqual([]);
});
