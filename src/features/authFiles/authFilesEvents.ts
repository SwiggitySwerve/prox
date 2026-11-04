import type { SourceOwner } from '@/services/api/sourceSession';
import {
  useCredentialInventoryStore,
  type CredentialChange,
} from '@/stores/useCredentialInventoryStore';
export const AUTH_FILES_CHANGED_EVENT = 'auth-files-changed';

/**
 * Credentials were added, removed or changed. Syncs prox-history, refreshes the one credential
 * inventory every screen reads, tells the other tabs, and finally raises the window event. Never
 * rejects: the change itself already succeeded, and the poll catches up if any step here fails.
 */
export const notifyAuthFilesChanged = async (
  owner?: SourceOwner,
  change: CredentialChange = { reason: 'change' }
): Promise<void> => {
  try {
    await useCredentialInventoryStore.getState().commitChange(change);
  } catch {
    // The next poll reconciles.
  } finally {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_FILES_CHANGED_EVENT, { detail: owner }));
    }
  }
};
