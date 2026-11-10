import { describe, expect, test } from 'bun:test';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { createAuthFilesApi, extractAccountExcludedModels } from '../src/services/api/authFiles';
import { SourceSessions } from '../src/services/api/sourceSession';

describe('extractAccountExcludedModels reads like the backend', () => {
  const cases: Array<[string, Record<string, unknown>, string[] | null]> = [
    ['no list', { type: 'claude' }, null],
    ['canonical list', { excluded_models: ['claude-3-*', ' x '] }, ['claude-3-*', 'x']],
    ['legacy alias', { 'excluded-models': ['a'] }, ['a']],
    ['canonical wins, even empty', { excluded_models: [], 'excluded-models': ['a'] }, []],
    ['canonical null means none', { excluded_models: null, 'excluded-models': ['a'] }, null],
    ['comma string', { excluded_models: 'a, b,,a' }, ['a', 'b']],
    ['case-insensitive dedupe keeps first spelling', { excluded_models: ['A', 'a'] }, ['A']],
    ['non-string entries are skipped', { excluded_models: ['a', 3, null] }, ['a']],
  ];
  for (const [name, file, expected] of cases) {
    test(name, () => expect(extractAccountExcludedModels(JSON.stringify(file))).toEqual(expected));
  }

  test('a non-list value is an error, not an empty list', () => {
    expect(() => extractAccountExcludedModels(JSON.stringify({ excluded_models: 5 }))).toThrow(
      'Invalid excluded_models'
    );
  });

  test('only the list leaves the parser, never other file fields', () => {
    const file = {
      excluded_models: ['a'],
      access_token: 'synthetic-not-a-token',
      email: 'x@example.invalid',
    };
    expect(JSON.stringify(extractAccountExcludedModels(JSON.stringify(file)))).toBe('["a"]');
  });
});

function fixture(respond: (config: InternalAxiosRequestConfig) => unknown) {
  const calls: InternalAxiosRequestConfig[] = [];
  const sessions = new SourceSessions();
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    return { data: await respond(config), status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    sessions.configure([
      {
        instanceId: 'alpha',
        configurationRevision: 'fixture',
        apiBase: 'https://alpha.invalid',
        managementKey: 'synthetic-test-key',
      },
    ]);
  } finally {
    axios.defaults.adapter = original;
  }
  return { calls, api: createAuthFilesApi(sessions.captureSource('alpha')) };
}

describe('account and provider list I/O', () => {
  test('writing an account list always uses the canonical key; null clears with []', async () => {
    const { calls, api } = fixture(() => ({ status: 'ok' }));
    await api.writeAccountExcludedModels('team-b.json', ['claude-3-*']);
    await api.writeAccountExcludedModels('team-b.json', null);
    expect(calls.map((call) => [call.method, call.url, JSON.parse(call.data as string)])).toEqual([
      ['patch', '/credentials/fields', { name: 'team-b.json', excluded_models: ['claude-3-*'] }],
      ['patch', '/credentials/fields', { name: 'team-b.json', excluded_models: [] }],
    ]);
  });

  test('reading an account list downloads the file and returns only the list', async () => {
    const { calls, api } = fixture(
      () =>
        new Blob([
          JSON.stringify({ excluded_models: ['x'], refresh_token: 'synthetic-not-a-token' }),
        ])
    );
    expect(await api.readAccountExcludedModels('team-b.json')).toEqual(['x']);
    expect(calls[0].url).toBe('/credentials/download?name=team-b.json');
  });

  test('provider list: read one provider, write replaces or removes only that entry', async () => {
    let stored: Record<string, string[]> = { claude: ['claude-3-*'], codex: ['gpt-5.4-mini'] };
    const { calls, api } = fixture((config) => {
      if (config.method === 'put') stored = JSON.parse(config.data as string);
      return stored;
    });
    expect(await api.readProviderExcludedModels('Claude')).toEqual(['claude-3-*']);
    expect(await api.readProviderExcludedModels('gemini')).toBeNull();
    await api.writeProviderExcludedModels('claude', ['claude-3-*', 'claude-haiku-4-5']);
    expect(stored).toEqual({ codex: ['gpt-5.4-mini'], claude: ['claude-3-*', 'claude-haiku-4-5'] });
    await api.writeProviderExcludedModels('claude', null);
    expect(stored).toEqual({ codex: ['gpt-5.4-mini'] });
    expect(calls.filter((call) => call.method === 'put')).toHaveLength(2);
  });
});
