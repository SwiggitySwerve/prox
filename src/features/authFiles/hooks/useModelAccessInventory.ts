import { useAuthFilesSource } from '../AuthFilesSourceContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  accountRefs,
  accountRefsKey,
  deriveInventoryLoad,
  inventoryOf,
  type AccountRef,
  type InventoryLoad,
  type ListIo,
  type ModelAccessInventory,
} from '@/features/authFiles/modelAccess';
import { modelAccess } from '@/features/authFiles/modelAccessRuntime';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
  useSourceFiles,
} from '@/stores/useCredentialInventoryStore';
import { selectSourceModelAccess, useModelAccessStore } from '@/stores/useModelAccessStore';

export type UseModelAccessInventoryResult = {
  load: InventoryLoad;
  /**
   * Re-read everything from the hub; `credentials: true` also re-lists the credential files
   * first. Resolves with the new inventory, or null when it could not be read.
   */
  reload: (options?: { credentials?: boolean }) => Promise<ModelAccessInventory | null>;
  io: ListIo;
};

/**
 * One provider's model access on this source, read from the shared model-access store (never a
 * private copy): the provider list, catalog, aliases, and per account its own list and the models
 * the hub reports. The accounts come from the shared credential inventory.
 */
export function useModelAccessInventory(provider: string): UseModelAccessInventoryResult {
  const scope = useAuthFilesSource();
  const api = scope.api;
  const owner = scope.session.owner;

  const sourceFiles = useSourceFiles(owner);
  const accounts = useMemo(
    () => (sourceFiles ? accountRefs(sourceFiles, provider) : undefined),
    [provider, sourceFiles]
  );
  const accountsKey = accounts ? accountRefsKey(accounts) : null;
  const accountsRef = useRef<AccountRef[] | undefined>(accounts);
  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const access = useModelAccessStore((state) => selectSourceModelAccess(state, owner));
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const load = useMemo(
    () => deriveInventoryLoad({ access, provider, accounts, credentialError }),
    [access, accounts, credentialError, provider]
  );

  /** Re-list this source's credentials; records why when that fails. */
  const listCredentials = useCallback(async (): Promise<AccountRef[] | undefined> => {
    const outcome = await useCredentialInventoryStore.getState().refresh();
    if (!scope.isCurrent()) return undefined;
    const failure = outcome[owner.instanceId];
    const files = selectSourceFiles(useCredentialInventoryStore.getState(), owner);
    setCredentialError(
      files ? null : (failure?.message ?? 'This source has no credential list yet.')
    );
    return files ? accountRefs(files, provider) : undefined;
  }, [owner, provider, scope]);

  const reload = useCallback(
    async (options?: { credentials?: boolean }): Promise<ModelAccessInventory | null> => {
      let refs = accountsRef.current;
      if (options?.credentials || !refs) refs = await listCredentials();
      if (!refs || !scope.isCurrent()) return null;
      await modelAccess().ensureProvider(owner, provider, refs, { force: true });
      if (!scope.isCurrent()) return null;
      return inventoryOf(
        deriveInventoryLoad({
          access: selectSourceModelAccess(useModelAccessStore.getState(), owner),
          provider,
          accounts: refs,
        })
      );
    },
    [listCredentials, owner, provider, scope]
  );

  // Automatic loads read the credential store's files and never re-list credentials, so a failing
  // source cannot start a refresh loop. While this source has no files yet, re-list them once per
  // provider, and only after the credential store is running (before that its refresh() is a
  // no-op whose empty outcome says nothing). Retrying after that is the user's explicit action.
  const storeStatus = useCredentialInventoryStore((state) => state.status);
  const listedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!provider) return;
    if (accountsKey !== null) {
      const refs = accountsRef.current ?? [];
      void modelAccess().ensureProvider(owner, provider, refs);
      return;
    }
    if (storeStatus === 'idle' || listedForRef.current === provider) return;
    listedForRef.current = provider;
    void listCredentials();
    // An abandoned attempt (StrictMode remount, provider switch) may list once more.
    return () => {
      listedForRef.current = null;
    };
  }, [accountsKey, listCredentials, owner, provider, storeStatus]);

  // The stale check and the writes always go to the hub directly; the store is re-read after.
  const io = useMemo<ListIo>(
    () => ({
      readProviderList: () => api.readProviderExcludedModels(provider),
      readAccountList: (name) => api.readAccountExcludedModels(name),
      writeProviderList: (rules) => api.writeProviderExcludedModels(provider, rules),
      writeAccountList: async (name, rules) => {
        await api.writeAccountExcludedModels(name, rules);
      },
    }),
    [api, provider]
  );

  return { load, reload, io };
}
