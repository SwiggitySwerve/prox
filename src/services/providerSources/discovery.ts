import { validateSourceDiscovery } from '@/domain/providerSources/manifest';
import type { SourceDiscovery } from '@/domain/providerSources/types';

/** Static, same-origin deployment metadata. No management credential is sent. */
export async function fetchSourceDiscovery(
  origin: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<SourceDiscovery | null> {
  const response = await fetcher(`${origin}/prox/sources.json`, {
    signal,
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Source discovery unavailable');
  // A standalone management.html host may route unknown paths to its HTML shell.
  if (response.headers.get('content-type')?.includes('text/html')) return null;
  const body = await response.text();
  if (body.length > 128 * 1024) throw new Error('Source discovery is too large');
  return validateSourceDiscovery(JSON.parse(body));
}
