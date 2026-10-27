import { afterEach, expect, test } from 'bun:test';
import type { AxiosAdapter, AxiosRequestConfig } from 'axios';
import {
  SourceSessions,
  sourceResourceKey,
  type SourceTransportEvent,
} from '../src/services/api/sourceSession';
import { ApiClient } from '../src/services/api/transport';

const a = {
  instanceId: 'alpha',
  apiBase: 'https://fixture.invalid/a',
  managementKey: 'fixture-a',
  configurationRevision: '1',
};
const b = {
  instanceId: 'beta',
  apiBase: 'https://fixture.invalid/b',
  managementKey: 'fixture-b',
  configurationRevision: '1',
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function observeWindow() {
  const events: Event[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    },
  });
  return events;
}
const ok: AxiosAdapter = async (config) => ({
  data: 'ok',
  status: 200,
  statusText: 'OK',
  headers: { 'x-cpa-version': 'v8-fixture', 'x-cpa-support-plugin': 'true' },
  config,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('concurrent sources retain destinations, credentials and source-local events', async () => {
  const globalEvents = observeWindow();
  const events: SourceTransportEvent[] = [];
  const sessions = new SourceSessions((event) => events.push(event));
  sessions.configure([a, b]);
  await Promise.all(
    [a, b].map(async (connection) => {
      const source = sessions.captureSource(connection.instanceId);
      const adapter: AxiosAdapter = async (config) => {
        expect(config.baseURL).toBe(`${connection.apiBase}/v8/management`);
        expect(config.headers.Authorization).toBe(`Bearer ${connection.managementKey}`);
        return ok(config);
      };
      expect(await source.management.get('/credentials', { adapter })).toBe('ok');
    })
  );
  expect(events).toHaveLength(4);
  expect(new Set(events.map((event) => event.owner.instanceId))).toEqual(
    new Set(['alpha', 'beta'])
  );
  const unauthorized: AxiosAdapter = async (config) => {
    throw { isAxiosError: true, message: 'Unauthorized', config, response: { status: 401 } };
  };
  await expect(
    sessions.captureSource('beta').management.get('/config', { adapter: unauthorized })
  ).rejects.toThrow('Unauthorized');
  expect(events.at(-1)).toEqual({
    type: 'unauthorized',
    owner: sessions.captureSource('beta').owner,
  });
  expect(globalEvents).toEqual([]);
  expect(await sessions.captureSource('alpha').management.get('/config', { adapter: ok })).toBe(
    'ok'
  );
});

test('replacement, removal and logout permanently invalidate captured owners, including ABA', async () => {
  const sessions = new SourceSessions();
  sessions.configure([a, b]);
  const first = sessions.captureSource('alpha');
  const beta = sessions.captureSource('beta');
  sessions.configure([{ ...a, managementKey: 'changed-fixture' }, b]);
  expect(first.signal.aborted).toBe(true);
  expect(sessions.captureSource('beta')).toBe(beta);
  sessions.configure([a, b]);
  expect(() => first.assertCurrent()).toThrow('Source session changed');
  const second = sessions.captureSource('alpha');
  expect(sourceResourceKey(second.owner, 'same.json')).not.toBe(
    sourceResourceKey(beta.owner, 'same.json')
  );
  expect(second.owner.sourceGeneration).toBeGreaterThan(first.owner.sourceGeneration);
  sessions.configure([b]);
  expect(second.signal.aborted).toBe(true);
  expect(() => sessions.captureSource('alpha')).toThrow('not authenticated');
  sessions.configure([a, b]);
  const third = sessions.captureSource('alpha');
  sessions.reset();
  sessions.configure([a, b]);
  expect(() => third.assertCurrent()).toThrow();
  expect(sessions.captureSource('alpha').owner.sessionEpoch).toBeGreaterThan(
    third.owner.sessionEpoch
  );
});

test('configuration validation is atomic and leaves existing owners usable', () => {
  const sessions = new SourceSessions();
  sessions.configure([a]);
  const original = sessions.captureSource('alpha');
  for (const invalid of [
    { ...b, apiBase: 'https://user:password@fixture.invalid' },
    { ...b, apiBase: 'https://fixture.invalid?q=1' },
    { ...b, apiBase: 'https://fixture.invalid/#hash' },
    { ...b, managementKey: '' },
    { ...b, instanceId: ' ' },
    { ...b, configurationRevision: '' },
  ]) {
    expect(() => sessions.configure([{ ...a, managementKey: 'new-fixture' }, invalid])).toThrow();
    expect(sessions.captureSource('alpha')).toBe(original);
    expect(original.signal.aborted).toBe(false);
  }
  expect(() => sessions.configure([a, a])).toThrow();
});

test('stale queued requests never dispatch and responses cannot publish after replacement', async () => {
  const events: SourceTransportEvent[] = [];
  const sessions = new SourceSessions((event) => events.push(event));
  sessions.configure([a]);
  const source = sessions.captureSource('alpha');
  let calls = 0;
  const queued = source.management.delete('/credentials', {
    adapter: async (config) => {
      calls++;
      return ok(config);
    },
  });
  sessions.reset();
  await expect(queued).rejects.toThrow();
  expect(calls).toBe(0);
  sessions.configure([a]);
  const dispatched = deferred<void>();
  const release = deferred<void>();
  const pending = sessions.captureSource('alpha').management.get('/config', {
    adapter: async (config) => {
      dispatched.resolve();
      await release.promise;
      return ok(config);
    },
  });
  await dispatched.promise;
  sessions.configure([{ ...a, configurationRevision: '2' }]);
  release.resolve();
  await expect(pending).rejects.toThrow();
  expect(events).toEqual([]);
});

test('owned requests reject escapes before any network adapter is called', async () => {
  const sessions = new SourceSessions();
  sessions.configure([a]);
  const source = sessions.captureSource('alpha');
  let calls = 0;
  const adapter: AxiosAdapter = async (config) => {
    calls++;
    return ok(config);
  };
  const cases: [string, AxiosRequestConfig?][] = [
    ['https://other.invalid/credentials'],
    ['//other.invalid/config'],
    ['../config'],
    ['/../config'],
    ['/a/%2e%2e/config'],
    ['/a%2f..%2fconfig'],
    ['/a%252fconfig'],
    ['/a\\config'],
    ['/a%00config'],
    ['/a#fragment'],
    ['/a%'],
    ['/config', { baseURL: 'https://other.invalid' }],
    ['/config', { auth: { username: 'x', password: 'y' } }],
  ];
  for (const [path, config] of cases)
    await expect(source.management.get(path, { ...config, adapter })).rejects.toThrow();
  expect(calls).toBe(0);
  await source.management.get('/credentials/download?name=folder%2Ffixture.json', { adapter });
  expect(calls).toBe(1);
});

test('request cancellation joins caller and owning session signals', async () => {
  const sessions = new SourceSessions();
  sessions.configure([a]);
  const caller = new AbortController();
  caller.abort();
  let calls = 0;
  await expect(
    sessions.captureSource('alpha').management.get('/config', {
      signal: caller.signal,
      adapter: async (config) => {
        calls++;
        return ok(config);
      },
    })
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test('late legacy response metadata and unauthorized events are suppressed across ABA', async () => {
  const events = observeWindow();
  const client = new ApiClient();
  for (const failure of [false, true]) {
    client.setConfig(a);
    const dispatched = deferred<void>();
    const release = deferred<void>();
    const pending = client.get('/config', {
      adapter: async (config) => {
        dispatched.resolve();
        await release.promise;
        if (failure)
          throw { isAxiosError: true, message: 'Unauthorized', config, response: { status: 401 } };
        return ok(config);
      },
    });
    await dispatched.promise;
    client.setConfig(b);
    client.setConfig(a);
    release.resolve();
    if (failure) await expect(pending).rejects.toThrow();
    else await pending;
  }
  expect(events).toEqual([]);
});
