import { containsControlCharacters } from '@/utils/helpers';
import type { AxiosRequestConfig } from 'axios';

export type TransportEvent =
  | { type: 'server-version-update'; detail: { version: string | null; buildDate: string | null } }
  | { type: 'server-plugin-support-update'; detail: { supportsPlugin: boolean } }
  | { type: 'unauthorized' }
  | { type: 'source-config-changed' };

export interface TransportPolicy {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  onEvent(event: TransportEvent): void;
}

/** Axios normally permits absolute URL/auth overrides. Owned transports do not. */
export function guardSourceRequest(config: AxiosRequestConfig, policy: TransportPolicy): void {
  policy.assertCurrent();
  const url = config.url ?? '';
  const path = url.split('?')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error('Invalid source request path');
  }
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    decoded.includes('\\') ||
    containsControlCharacters(decoded) ||
    /(^|\/)\.\.?($|\/)/.test(decoded) ||
    /%(?:25|2f|5c)/i.test(path) ||
    path.includes('#') ||
    config.baseURL !== undefined ||
    config.auth !== undefined
  )
    throw new Error('Request escapes its source transport');
  config.signal = config.signal
    ? AbortSignal.any([policy.signal, config.signal as AbortSignal])
    : policy.signal;
}
