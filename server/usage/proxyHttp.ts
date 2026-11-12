// Authenticated, bounded management reads. Never include upstream error bodies in logs/status.
export class UsageAuthError extends Error {
  constructor() {
    super('Management authentication failed');
  }
}

export async function readProxyJson(
  origin: string,
  path: string,
  key: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<unknown> {
  const response = await fetcher(`${origin}/v8/management/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) throw new UsageAuthError();
  if (!response.ok) throw new Error(`Management request failed (${response.status})`);
  return response.json();
}
