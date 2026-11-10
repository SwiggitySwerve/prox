import { useAuthFilesSource } from '../AuthFilesSourceContext';
import { useCallback, useState } from 'react';

import type { AuthFileItem } from '@/types';
import { accountRefOf, providerOfFile } from '@/features/authFiles/modelAccess';
import { modelAccess } from '@/features/authFiles/modelAccessRuntime';

export type UseAuthFilesModelsResult = {
  modelsModalOpen: boolean;
  /** The credential the dialog shows; kept after closing so the close animation has content. */
  modelsFile: AuthFileItem | null;
  showModels: (item: AuthFileItem) => void;
  reloadModels: () => void;
  closeModelsModal: () => void;
  /** After a credential changed: forget its model-access slices (all of them without names). */
  invalidateModels: (names?: string[]) => void;
};

/**
 * Which credential's models dialog is open. The data is not held here: the dialog reads the
 * shared model-access store, the same slices the Models screen shows for this account.
 */
export function useAuthFilesModels(): UseAuthFilesModelsResult {
  const sourceScope = useAuthFilesSource();
  const owner = sourceScope.session.owner;
  const [modelsModalOpen, setModelsModalOpen] = useState(false);
  const [modelsFile, setModelsFile] = useState<AuthFileItem | null>(null);

  const load = useCallback(
    (item: AuthFileItem, force: boolean) => {
      void modelAccess().ensureProvider(owner, providerOfFile(item), [accountRefOf(item)], {
        force,
      });
    },
    [owner]
  );

  const showModels = useCallback(
    (item: AuthFileItem) => {
      if (!sourceScope.isCurrent()) return;
      setModelsFile(item);
      setModelsModalOpen(true);
      load(item, false);
    },
    [load, sourceScope]
  );

  const reloadModels = useCallback(() => {
    if (modelsFile && sourceScope.isCurrent()) load(modelsFile, true);
  }, [load, modelsFile, sourceScope]);

  const closeModelsModal = useCallback(() => setModelsModalOpen(false), []);

  const invalidateModels = useCallback(
    (names?: string[]) => modelAccess().invalidateAccounts(owner, names),
    [owner]
  );

  return {
    modelsModalOpen,
    modelsFile,
    showModels,
    reloadModels,
    closeModelsModal,
    invalidateModels,
  };
}
