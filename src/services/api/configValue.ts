import { apiClient } from './client';
import type { ManagementTransport } from './sourceSession';

/** Capture before a config read and check immediately before its dependent write. */
export function guardConfigConnection(): () => void {
  const revision = apiClient.getConnectionRevision();
  return () => {
    if (revision !== apiClient.getConnectionRevision()) {
      throw new DOMException('The management connection changed.', 'AbortError');
    }
  };
}

/** Only an absent persisted config field is optional, not a missing API route. */
export const isMissingConfigValue = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  error.status === 404 &&
  'apiCode' in error &&
  error.apiCode === 'not_found';

/** Keep config reads and dependent-write guards bound to the same connection. */
export function createConfigValueApi(
  transport: Pick<ManagementTransport, 'get'>,
  captureGuard: () => () => void
) {
  async function getConfigValue<T>(path: string, defaultValue: T): Promise<T> {
    try {
      return await transport.get<T>(path);
    } catch (error) {
      if (isMissingConfigValue(error)) return defaultValue;
      throw error;
    }
  }

  return { getConfigValue, guardConfigConnection: captureGuard };
}

export const { getConfigValue } = createConfigValueApi(apiClient, guardConfigConnection);
