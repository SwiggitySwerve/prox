import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { type ApiCallRequest } from '../src/services/api/apiCall';
import { ProviderSourceProvider } from '../src/features/providers/ProviderSourceContext';
import type { ManagementTransport, SourceSession } from '../src/services/api/sourceSession';
import { normalizeProviderGroups } from '../src/services/api/transformers';
import type { ProviderKeyConfig } from '../src/types/provider';
import {
  useConnectivityTest,
  type UseConnectivityTestArgs,
  type ConnectivityErrorMessages,
} from '../src/features/providers/sheets/forms/useConnectivityTest';
import { useModelDiscovery } from '../src/features/providers/sheets/forms/useModelDiscovery';

function captureHook<T>(hook: () => T): T {
  let result: T;
  function Harness() {
    result = hook();
    return null;
  }
  renderToStaticMarkup(
    createElement(ProviderSourceProvider, {
      source: {
        instanceId: 'test',
        label: 'Test',
        apiBase: 'https://source.invalid',
        publicBasePath: '',
        aliases: [],
        authScope: 'test',
      },
      session,
      children: createElement(Harness),
    })
  );
  return result!;
}

const messages: ConnectivityErrorMessages = {
  baseUrlRequired: 'base required',
  endpointInvalid: 'invalid endpoint',
  apiKeyRequired: 'key required',
  modelRequired: 'model required',
  timeout: () => 'timeout',
  requestFailed: 'failed',
};
const success = { status_code: 200, header: {}, body: { data: [] } };
const transport: ManagementTransport = {
  get: async () => {
    throw new Error('Unexpected GET');
  },
  post: async () => {
    throw new Error('Unexpected POST');
  },
  put: async () => {
    throw new Error('Unexpected PUT');
  },
  patch: async () => {
    throw new Error('Unexpected PATCH');
  },
  delete: async () => {
    throw new Error('Unexpected DELETE');
  },
  getRaw: async () => {
    throw new Error('Unexpected raw GET');
  },
  postForm: async () => {
    throw new Error('Unexpected form');
  },
};
const session: SourceSession = {
  owner: { instanceId: 'test', sessionEpoch: 1, sourceGeneration: 1 },
  signal: new AbortController().signal,
  assertCurrent: () => {},
  management: transport,
};
let requestSpy: ReturnType<typeof spyOn<typeof transport, 'post'>> | undefined;
afterEach(() => requestSpy?.mockRestore());

const args: UseConnectivityTestArgs = {
  brand: 'codex',
  baseUrl: 'https://upstream.example/v1',
  apiKey: 'fixture-key',
  proxyUrl: ' socks5://proxy.example:1080 ',
  models: [{ name: 'fixture-model', alias: '' }],
  formHeaders: [],
};

describe('provider probe proxy forwarding', () => {
  test.each(['codex', 'meta', 'xai', 'gemini', 'interactions', 'claude'] as const)(
    '%s connectivity uses the current form proxy',
    async (brand) => {
      requestSpy = spyOn(transport, 'post').mockResolvedValue(success);
      const hook = captureHook(() => useConnectivityTest({ ...args, brand }, messages));
      if (brand === 'claude') await hook.runClaude();
      else if (brand === 'gemini' || brand === 'interactions') await hook.runGemini();
      else await hook.runCodex();
      expect((requestSpy.mock.calls[0][1] as ApiCallRequest).proxy_url).toBe(
        'socks5://proxy.example:1080'
      );
    }
  );

  test('OpenAI batch tests preserve each key proxy, including direct and blank', async () => {
    requestSpy = spyOn(transport, 'post').mockResolvedValue(success);
    const hook = captureHook(() =>
      useConnectivityTest(
        {
          ...args,
          brand: 'openaiCompatibility',
          apiKeyEntries: [' http://one.example:8080 ', 'direct', ''].map((proxyUrl) => ({
            apiKey: 'fixture-key',
            proxyUrl,
          })),
        },
        messages
      )
    );
    await hook.runOpenAIAllKeys();
    expect(
      requestSpy.mock.calls.map(([, request]) => (request as ApiCallRequest).proxy_url)
    ).toEqual(['http://one.example:8080', 'direct', undefined]);
  });

  test.each(['codex', 'meta', 'xai', 'gemini', 'interactions', 'claude'] as const)(
    '%s discovery forwards the effective inherited proxy',
    async (brand) => {
      requestSpy = spyOn(transport, 'post').mockResolvedValue(success);
      const [config] = normalizeProviderGroups([
        { 'base-url': args.baseUrl, 'proxy-url': 'direct', keys: [{ 'api-key': 'fixture-key' }] },
      ]) as ProviderKeyConfig[];
      const hook = captureHook(() =>
        useModelDiscovery({ ...args, brand, proxyUrl: config.proxyUrl })
      );
      await hook.fetch();
      expect((requestSpy.mock.calls[0][1] as ApiCallRequest).proxy_url).toBe('direct');
    }
  );

  test('OpenAI unauthenticated discovery retry keeps the selected key proxy', async () => {
    const requests: ApiCallRequest[] = [];
    requestSpy = spyOn(transport, 'post').mockImplementation(async (_path, request) => {
      requests.push(request as ApiCallRequest);
      return requests.length === 1 ? { ...success, status_code: 401 } : success;
    });
    const hook = captureHook(() =>
      useModelDiscovery({
        ...args,
        brand: 'openaiCompatibility',
        apiKeyEntries: [{ apiKey: 'fixture-key', proxyUrl: ' direct ' }],
      })
    );
    await hook.fetch();
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.proxy_url)).toEqual(['direct', 'direct']);
    expect(requests[0].header?.Authorization).toBe('Bearer fixture-key');
    expect(requests[1].header).toBeUndefined();
    expect(requests[1].authIndex).toBeUndefined();
  });

  test('base and sponsor forms pass their editable proxy to probe hooks', () => {
    const base = readFileSync('src/features/providers/sheets/forms/BaseProviderForm.tsx', 'utf8');
    const sponsor = readFileSync(
      'src/features/providers/sheets/forms/SponsorProviderForm.tsx',
      'utf8'
    );
    expect(base.match(/proxyUrl: form\.proxyUrl/g)).toHaveLength(2);
    expect(sponsor).toContain('proxyUrl: entry.proxyUrl,\n    formHeaders: discoveryHeaders');
  });
});
