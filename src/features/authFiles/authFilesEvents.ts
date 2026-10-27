import type { SourceOwner } from '@/services/api/sourceSession';
export const AUTH_FILES_CHANGED_EVENT = 'auth-files-changed';

export const notifyAuthFilesChanged = (owner?: SourceOwner) => {
  window.dispatchEvent(new CustomEvent(AUTH_FILES_CHANGED_EVENT, { detail: owner }));
};
