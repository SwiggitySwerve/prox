/**
 * 可用模型获取
 */

import axios from 'axios';
import { normalizeModelList } from '@/utils/models';
import { normalizeApiBase } from '@/utils/connection';
import { apiCallApi, createApiCallApi, getApiCallErrorMessage } from './apiCall';
import { isRecord } from '@/utils/helpers';
import type { SourceSession } from './sourceSession';
import { createApiKeysApi } from './apiKeys';

const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const buildRequestSignature = (
  url: string,
  headers: Record<string, string>,
  authIndex?: string,
  proxyUrl?: string
) => {
  const headerSignature = Object.entries(headers)
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([key, value]) => `${key}:${value}`)
    .join('|');
  return JSON.stringify([url, headerSignature, authIndex ?? '', proxyUrl ?? '']);
};

const buildModelsEndpoint = (baseUrl: string): string => {
  const normalized = normalizeApiBase(baseUrl);
  if (!normalized) return '';
  const trimmed = normalized.replace(/\/+$/g, '');
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${trimmed}/models`;
};

const buildV1ModelsEndpoint = (baseUrl: string): string => {
  const normalized = normalizeApiBase(baseUrl);
  if (!normalized) return '';
  const trimmed = normalized.replace(/\/+$/g, '');
  if (/\/v1\/models$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
};

const buildClaudeModelsEndpoint = (baseUrl: string): string => {
  const normalized = normalizeApiBase(baseUrl);
  const fallback = normalized || DEFAULT_CLAUDE_BASE_URL;
  let trimmed = fallback.replace(/\/+$/g, '');
  trimmed = trimmed.replace(/\/v1\/models$/i, '');
  trimmed = trimmed.replace(/\/v1(?:\/.*)?$/i, '');
  return `${trimmed}/v1/models`;
};

const buildGeminiModelsEndpoint = (baseUrl: string): string => {
  const normalized = normalizeApiBase(baseUrl);
  const fallback = normalized || DEFAULT_GEMINI_BASE_URL;
  let trimmed = fallback.replace(/\/+$/g, '');
  trimmed = trimmed.replace(/\/v1beta\/models$/i, '');
  trimmed = trimmed.replace(/\/v1beta(?:\/.*)?$/i, '');
  return `${trimmed}/v1beta/models`;
};

const stripGeminiModelResourceName = (value: string): string => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/^\/?models\//i, '');
};

const hasHeader = (headers: Record<string, string>, name: string) => {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
};

const resolveBearerTokenFromAuthorization = (headers: Record<string, string>): string => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
  if (!entry) return '';
  const value = String(entry[1] ?? '').trim();
  if (!value) return '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
};

export interface ModelsSourceOptions {
  /** Exact client-key catalog route from the owning source, not the management transport. */
  readonly modelsUrl: string;
}

export function createModelsApi(session: SourceSession, options: ModelsSourceOptions) {
  const keys = createApiKeysApi(session);
  return buildModelsApi(
    createApiCallApi(session),
    async (_baseUrl, apiKey) => {
      const signal = session.signal;
      session.assertCurrent();
      signal.throwIfAborted();
      const clientKeys = await keys.list();
      session.assertCurrent();
      signal.throwIfAborted();
      const key = apiKey?.trim() || clientKeys[0];
      if (!key || !clientKeys.includes(key)) throw new Error('A source client API key is required');
      // This transport has no management credentials, defaults, or caller-supplied headers.
      const response = await axios.get(options.modelsUrl, {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      });
      session.assertCurrent();
      signal.throwIfAborted();
      const payload = response.data?.data ?? response.data?.models ?? response.data;
      return normalizeModelList(payload, { dedupe: true });
    },
    () => session.signal
  );
}

function buildModelsApi(
  apiCall: typeof apiCallApi,
  fetchCatalog?: (
    baseUrl: string,
    apiKey?: string
  ) => Promise<ReturnType<typeof normalizeModelList>>,
  captureSignal?: () => AbortSignal
) {
  type InFlight = { promise: Promise<ReturnType<typeof normalizeModelList>>; signal?: AbortSignal };
  const CLAUDE_MODELS_IN_FLIGHT = new Map<string, InFlight>();
  const GEMINI_MODELS_IN_FLIGHT = new Map<string, InFlight>();

  return {
    /**
     * Fetch available models from /v1/models endpoint (for system info page)
     */
    async fetchModels(baseUrl: string, apiKey?: string, headers: Record<string, string> = {}) {
      if (fetchCatalog) return fetchCatalog(baseUrl, apiKey);
      const endpoint = buildV1ModelsEndpoint(baseUrl);
      if (!endpoint) {
        throw new Error('Invalid base url');
      }

      const resolvedHeaders = { ...headers };
      if (apiKey && !hasHeader(resolvedHeaders, 'authorization')) {
        resolvedHeaders.Authorization = `Bearer ${apiKey}`;
      }

      const response = await axios.get(endpoint, {
        headers: Object.keys(resolvedHeaders).length ? resolvedHeaders : undefined,
      });
      const payload = response.data?.data ?? response.data?.models ?? response.data;
      return normalizeModelList(payload, { dedupe: true });
    },

    /**
     * Fetch models from /v1/models endpoint via api-call.
     * Useful when the configured baseUrl is the upstream host root (e.g. https://api.example.com).
     */
    async fetchV1ModelsViaApiCall(
      baseUrl: string,
      apiKey?: string,
      headers: Record<string, string> = {},
      authIndex?: string,
      proxyUrl?: string
    ) {
      const signal = captureSignal?.();
      signal?.throwIfAborted();
      const endpoint = buildV1ModelsEndpoint(baseUrl);
      if (!endpoint) {
        throw new Error('Invalid base url');
      }

      const trimmedAuthIndex = authIndex?.trim() || undefined;
      const resolvedHeaders = { ...headers };
      if (apiKey && !hasHeader(resolvedHeaders, 'authorization')) {
        resolvedHeaders.Authorization = `Bearer ${apiKey}`;
      } else if (trimmedAuthIndex && !hasHeader(resolvedHeaders, 'authorization')) {
        resolvedHeaders.Authorization = 'Bearer $TOKEN$';
      }

      signal?.throwIfAborted();
      const result = await apiCall.request(
        {
          authIndex: trimmedAuthIndex,
          proxy_url: proxyUrl?.trim() || undefined,
          method: 'GET',
          url: endpoint,
          header: Object.keys(resolvedHeaders).length ? resolvedHeaders : undefined,
        },
        signal ? { signal } : undefined
      );
      signal?.throwIfAborted();

      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(getApiCallErrorMessage(result));
      }

      const payload = result.body ?? result.bodyText;
      return normalizeModelList(payload, { dedupe: true });
    },

    /**
     * Fetch models from /models endpoint via api-call (for OpenAI provider discovery)
     */
    async fetchModelsViaApiCall(
      baseUrl: string,
      apiKey?: string,
      headers: Record<string, string> = {},
      authIndex?: string,
      proxyUrl?: string
    ) {
      const signal = captureSignal?.();
      signal?.throwIfAborted();
      const endpoint = buildModelsEndpoint(baseUrl);
      if (!endpoint) {
        throw new Error('Invalid base url');
      }

      const trimmedAuthIndex = authIndex?.trim() || undefined;
      const resolvedHeaders = { ...headers };
      if (apiKey && !hasHeader(resolvedHeaders, 'authorization')) {
        resolvedHeaders.Authorization = `Bearer ${apiKey}`;
      } else if (trimmedAuthIndex && !hasHeader(resolvedHeaders, 'authorization')) {
        resolvedHeaders.Authorization = 'Bearer $TOKEN$';
      }

      signal?.throwIfAborted();
      const result = await apiCall.request(
        {
          authIndex: trimmedAuthIndex,
          proxy_url: proxyUrl?.trim() || undefined,
          method: 'GET',
          url: endpoint,
          header: Object.keys(resolvedHeaders).length ? resolvedHeaders : undefined,
        },
        signal ? { signal } : undefined
      );
      signal?.throwIfAborted();

      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(getApiCallErrorMessage(result));
      }

      const payload = result.body ?? result.bodyText;
      return normalizeModelList(payload, { dedupe: true });
    },

    /**
     * Fetch Claude models from /v1/models via api-call.
     * Anthropic requires `x-api-key` and `anthropic-version` headers.
     */
    async fetchClaudeModelsViaApiCall(
      baseUrl: string,
      apiKey?: string,
      headers: Record<string, string> = {},
      authIndex?: string,
      proxyUrl?: string
    ) {
      const signal = captureSignal?.();
      signal?.throwIfAborted();
      const endpoint = buildClaudeModelsEndpoint(baseUrl);
      if (!endpoint) {
        throw new Error('Invalid base url');
      }

      const trimmedAuthIndex = authIndex?.trim() || undefined;
      const resolvedHeaders = { ...headers };
      let resolvedApiKey = String(apiKey ?? '').trim();
      if (!resolvedApiKey && !hasHeader(resolvedHeaders, 'x-api-key')) {
        resolvedApiKey = resolveBearerTokenFromAuthorization(resolvedHeaders);
      }

      if (resolvedApiKey && !hasHeader(resolvedHeaders, 'x-api-key')) {
        resolvedHeaders['x-api-key'] = resolvedApiKey;
      } else if (trimmedAuthIndex && !hasHeader(resolvedHeaders, 'x-api-key')) {
        resolvedHeaders['x-api-key'] = '$TOKEN$';
      }
      if (!hasHeader(resolvedHeaders, 'anthropic-version')) {
        resolvedHeaders['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
      }

      const signature = buildRequestSignature(
        endpoint,
        resolvedHeaders,
        trimmedAuthIndex,
        proxyUrl?.trim() || undefined
      );
      const existing = CLAUDE_MODELS_IN_FLIGHT.get(signature);
      if (existing && !existing.signal?.aborted) return existing.promise;

      const request = (async () => {
        signal?.throwIfAborted();
        const result = await apiCall.request(
          {
            authIndex: trimmedAuthIndex,
            proxy_url: proxyUrl?.trim() || undefined,
            method: 'GET',
            url: endpoint,
            header: Object.keys(resolvedHeaders).length ? resolvedHeaders : undefined,
          },
          signal ? { signal } : undefined
        );
        signal?.throwIfAborted();

        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error(getApiCallErrorMessage(result));
        }

        const payload = result.body ?? result.bodyText;
        return normalizeModelList(payload, { dedupe: true });
      })();

      CLAUDE_MODELS_IN_FLIGHT.set(signature, { promise: request, signal });
      try {
        return await request;
      } finally {
        if (CLAUDE_MODELS_IN_FLIGHT.get(signature)?.promise === request)
          CLAUDE_MODELS_IN_FLIGHT.delete(signature);
      }
    },

    /**
     * Fetch Gemini models from /v1beta/models via api-call.
     * Gemini API accepts API key via query param or `x-goog-api-key` header.
     */
    async fetchGeminiModelsViaApiCall(
      baseUrl: string,
      apiKey?: string,
      headers: Record<string, string> = {},
      authIndex?: string,
      proxyUrl?: string
    ) {
      const signal = captureSignal?.();
      signal?.throwIfAborted();
      const endpoint = buildGeminiModelsEndpoint(baseUrl);
      if (!endpoint) {
        throw new Error('Invalid base url');
      }

      const trimmedAuthIndex = authIndex?.trim() || undefined;
      const resolvedHeaders = { ...headers };
      const resolvedApiKey = String(apiKey ?? '').trim();
      if (resolvedApiKey && !hasHeader(resolvedHeaders, 'x-goog-api-key')) {
        resolvedHeaders['x-goog-api-key'] = resolvedApiKey;
      } else if (trimmedAuthIndex && !hasHeader(resolvedHeaders, 'x-goog-api-key')) {
        resolvedHeaders['x-goog-api-key'] = '$TOKEN$';
      }

      const signature = buildRequestSignature(
        endpoint,
        resolvedHeaders,
        trimmedAuthIndex,
        proxyUrl?.trim() || undefined
      );
      const existing = GEMINI_MODELS_IN_FLIGHT.get(signature);
      if (existing && !existing.signal?.aborted) return existing.promise;

      const request = (async () => {
        const seen = new Set<string>();
        const collected: ReturnType<typeof normalizeModelList> = [];
        let pageToken = '';

        for (let page = 0; page < 20; page += 1) {
          const url = new URL(endpoint);
          if (pageToken) {
            url.searchParams.set('pageToken', pageToken);
          }

          signal?.throwIfAborted();
          const result = await apiCall.request(
            {
              authIndex: trimmedAuthIndex,
              proxy_url: proxyUrl?.trim() || undefined,
              method: 'GET',
              url: url.toString(),
              header: Object.keys(resolvedHeaders).length ? resolvedHeaders : undefined,
            },
            signal ? { signal } : undefined
          );
          signal?.throwIfAborted();

          if (result.statusCode < 200 || result.statusCode >= 300) {
            throw new Error(getApiCallErrorMessage(result));
          }

          const payload = result.body ?? result.bodyText;
          const normalized = normalizeModelList(payload, { dedupe: false });
          normalized.forEach((model) => {
            const name = stripGeminiModelResourceName(model.name);
            const key = (name || '').toLowerCase();
            if (!key || seen.has(key)) return;
            seen.add(key);
            const resolved = { ...model, name };
            if (resolved.alias && resolved.alias.trim() === name) {
              resolved.alias = undefined;
            }
            collected.push(resolved);
          });

          const nextToken =
            isRecord(payload) && typeof payload.nextPageToken === 'string'
              ? payload.nextPageToken
              : '';
          if (!nextToken) {
            break;
          }
          pageToken = nextToken;
        }

        return collected;
      })();

      GEMINI_MODELS_IN_FLIGHT.set(signature, { promise: request, signal });
      try {
        return await request;
      } finally {
        if (GEMINI_MODELS_IN_FLIGHT.get(signature)?.promise === request)
          GEMINI_MODELS_IN_FLIGHT.delete(signature);
      }
    },
  };
}

export const modelsApi = buildModelsApi(apiCallApi);
