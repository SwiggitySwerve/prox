import { normalizeApiBase } from '@/utils/connection';
import type { PoolProviderId } from '@/domain/quotaPool/types';

/** Resolve sibling routes on this Prox deployment, never on an arbitrary backend. */
export function managementRuntime(apiBase: string, appOrigin: string) {
  try {
    const url = new URL(normalizeApiBase(apiBase));
    if (url.origin !== appOrigin || !['', '/', '/codex', '/claude'].includes(url.pathname))
      return null;
    return {
      provider: (url.pathname === '/claude' ? 'claude' : 'codex') as PoolProviderId,
      baseFor: (provider: PoolProviderId) => `${url.origin}/${provider}`,
    };
  } catch {
    return null;
  }
}
