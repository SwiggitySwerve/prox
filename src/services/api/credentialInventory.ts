import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

export interface CredentialInventorySync {
  reason: 'add' | 'delete' | 'change';
  deletedNames?: string[];
}

export type CredentialInventoryRead =
  { status: 'unchanged' } | { status: 'changed'; version: string };

/** prox-history's credential inventory, reached through the same /prox routes as the pools. */
export function createCredentialInventoryApi() {
  const client = apiClient.captureConnection();
  return {
    /**
     * Conditional read: with the version already held the server answers 304 when nothing
     * changed. The ETag is the quoted version, so the version alone is enough to ask.
     */
    read: async (known: string | null, signal?: AbortSignal): Promise<CredentialInventoryRead> => {
      const response = await client.getRaw('/prox/inventory', {
        headers: known ? { 'If-None-Match': `"${known}"` } : {},
        signal,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
      });
      if (response.status === 304) return { status: 'unchanged' };
      const body: unknown = response.data;
      if (!isRecord(body) || typeof body.version !== 'string' || !body.version) {
        throw new Error('Invalid credential inventory version');
      }
      return { status: 'changed', version: body.version };
    },
    /** Re-read now; `deletedNames` lets the server purge what the user deleted by name. */
    sync: async (change: CredentialInventorySync, signal?: AbortSignal): Promise<void> => {
      await client.post('/prox/inventory/sync', change, { signal });
    },
  };
}
