/**
 * OAuth and device-code login API
 */

import { apiClient } from './client';
import type { SourceSession, ManagementTransport } from './sourceSession';
import {
  isManagementOAuthProviderKey,
  normalizeManagementOAuthProviderKey,
} from '@/utils/providerKeys';

export type BuiltInOAuthProvider =
  'codex' | 'anthropic' | 'antigravity' | 'kimi' | 'kimi-ai' | 'xai' | 'devin' | 'meta';

export interface OAuthStartResponse {
  url: string;
  state?: string;
  user_code?: string;
  flow?: string;
  expires_in?: number;
}

export interface OAuthCallbackResponse {
  status: 'ok';
}

export interface OAuthCancelResponse {
  status: 'ok';
  cancelled: boolean;
}

const WEBUI_SUPPORTED = new Set<string>(['codex', 'claude', 'antigravity', 'xai', 'devin']);

const normalizeProviderForManagementPath = (provider: string): string => {
  const key = normalizeManagementOAuthProviderKey(provider);
  if (!isManagementOAuthProviderKey(key)) {
    throw new Error('Invalid OAuth provider');
  }
  return key === 'anthropic' ? 'claude' : key;
};

export interface SiwcBindResponse {
  status: 'ok';
  url: string;
  state: string;
  flow: 'siwc_bind';
  expires_in: number;
}

function buildOAuthApi(client: ManagementTransport) {
  return {
    startSiwcBind: (name: string, signal?: AbortSignal) =>
      client.post<SiwcBindResponse>('/oauth/siwc/bind', { name }, signal ? { signal } : undefined),

    startAuth: (provider: string, signal?: AbortSignal) => {
      const providerKey = normalizeProviderForManagementPath(provider);
      const params: Record<string, string | boolean> = { provider: providerKey };
      if (WEBUI_SUPPORTED.has(providerKey)) {
        params.is_webui = true;
      }
      return client.get<OAuthStartResponse>('/oauth/auth-url', {
        params,
        ...(signal ? { signal } : {}),
      });
    },

    getAuthStatus: (state: string, signal?: AbortSignal) =>
      client.get<{ status: 'ok' | 'wait' | 'error'; error?: string }>(`/oauth/status`, {
        params: { state },
        ...(signal ? { signal } : {}),
      }),

    cancelSession: (state: string, signal?: AbortSignal) =>
      client.delete<OAuthCancelResponse>('/oauth/session', {
        params: { state },
        ...(signal ? { signal } : {}),
      }),

    submitCallback: (provider: string, redirectUrl: string, signal?: AbortSignal) => {
      const providerKey = normalizeProviderForManagementPath(provider);
      return client.post<OAuthCallbackResponse>(
        '/oauth/callback',
        { provider: providerKey, redirect_url: redirectUrl },
        signal ? { signal } : undefined
      );
    },
  };
}

export function createOAuthApi(session: SourceSession) {
  return buildOAuthApi(session.management);
}

export const oauthApi = buildOAuthApi(apiClient);

/** Start and cleanup must use the same connection, even after the dialog closes. */
export function captureSiwcBindingApi(session?: SourceSession) {
  // Closing a dialog must not abort startup: its late state still needs cancellation.
  // A revoked source, however, must fail closed through its own transport.
  const client = session ? session.management : apiClient.captureConnection();
  return {
    start: (name: string) => client.post<SiwcBindResponse>('/oauth/siwc/bind', { name }),
    cancel: (state: string) => client.delete('/oauth/session', { params: { state } }),
  };
}
