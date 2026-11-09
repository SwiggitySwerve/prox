import { useAuthFilesSource } from '../AuthFilesSourceContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isRuntimeOnlyAuthFile, normalizeProviderKey } from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import {
  INITIAL_INVENTORY_LOAD,
  InvalidTransitionError,
  transitionInventory,
  type AccountAccess,
  type InventoryEvent,
  type InventoryLoad,
  type ListIo,
  type ModelAccessInventory,
} from '@/features/authFiles/modelAccess';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
  useSourceFiles,
} from '@/stores/useCredentialInventoryStore';
import type { AuthFileItem } from '@/types';

/** Parallel per-account reads; enough to be quick, few enough not to flood a hub. */
const ACCOUNT_READ_CONCURRENCY = 4;

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export const providerOfFile = (file: AuthFileItem) =>
  normalizeProviderKey(String(file.type ?? file.provider ?? ''));

export type UseModelAccessInventoryResult = {
  load: InventoryLoad;
  /**
   * Re-read everything; `credentials: true` also re-lists the credential files first. Resolves
   * with the new inventory, or null when the read failed or was superseded.
   */
  reload: (options?: { credentials?: boolean }) => Promise<ModelAccessInventory | null>;
  io: ListIo;
};

/**
 * One provider's model access, read once and shared by every cell: the provider list, the
 * catalog, aliases, and per account its own list and the models the hub reports. Credential
 * files come from the shared credential inventory store, never from a list of this screen's own.
 */
export function useModelAccessInventory(provider: string): UseModelAccessInventoryResult {
  const scope = useAuthFilesSource();
  const api = scope.api;
  const owner = scope.session.owner;
  const [load, setLoad] = useState<InventoryLoad>(INITIAL_INVENTORY_LOAD);
  const generationRef = useRef(0);

  const send = useCallback((event: InventoryEvent) => {
    setLoad((current) => {
      try {
        return transitionInventory(current, event);
      } catch (error) {
        // A dropped event is logged, never thrown into render.
        if (error instanceof InvalidTransitionError) {
          console.warn(error.message);
          return current;
        }
        throw error;
      }
    });
  }, []);

  // Follow the shared credential store: this provider's accounts (name and disabled flag) decide
  // when the inventory must be read again, including the first time the store is filled.
  const sourceFiles = useSourceFiles(owner);
  const providerFiles = useMemo(
    () =>
      sourceFiles?.filter(
        (file) => providerOfFile(file) === provider && !isRuntimeOnlyAuthFile(file)
      ),
    [provider, sourceFiles]
  );
  const filesKey = providerFiles
    ? providerFiles.map((file) => `${file.name}:${file.disabled === true}`).join('|')
    : null;
  const providerFilesRef = useRef(providerFiles);
  useEffect(() => {
    providerFilesRef.current = providerFiles;
  }, [providerFiles]);

  const reload = useCallback(
    async (options?: { credentials?: boolean }): Promise<ModelAccessInventory | null> => {
      const generation = ++generationRef.current;
      const current = () => generation === generationRef.current && scope.isCurrent();
      send({ type: 'LOAD', generation });
      try {
        let files = providerFilesRef.current;
        if (options?.credentials || !files) {
          const outcome = await useCredentialInventoryStore.getState().refresh();
          scope.assertCurrent();
          const failure = outcome[owner.instanceId];
          if (failure) throw failure;
          files = selectSourceFiles(useCredentialInventoryStore.getState(), owner)?.filter(
            (file) => providerOfFile(file) === provider && !isRuntimeOnlyAuthFile(file)
          );
          if (!files) throw new Error('This source has no credential list yet.');
        }
        const [lists, catalog, aliases] = await Promise.all([
          api.getOauthExcludedModels(),
          api.getModelDefinitions(provider).then(
            (models) => models.map((model) => model.id).filter(Boolean),
            () => [] as string[]
          ),
          api.getOauthModelAlias().then(
            (map) => map[provider] ?? [],
            () => []
          ),
        ]);
        scope.assertCurrent();
        const accounts = await mapLimited(
          files,
          ACCOUNT_READ_CONCURRENCY,
          async (file): Promise<AccountAccess> => {
            const disabled = file.disabled === true;
            const [own, reported] = await Promise.allSettled([
              api.readAccountExcludedModels(file.name),
              disabled ? Promise.resolve([]) : api.getModelsForAuthFile(file.name),
            ]);
            return {
              name: file.name,
              label: deriveAuthFileIdentity(file).primary || file.name,
              disabled,
              ownList:
                own.status === 'fulfilled'
                  ? { status: 'known', rules: own.value }
                  : { status: 'unknown', message: errorMessage(own.reason) },
              reported:
                reported.status === 'fulfilled'
                  ? {
                      status: 'known',
                      ids: reported.value.map((model) => model.id).filter(Boolean),
                    }
                  : { status: 'unknown', message: errorMessage(reported.reason) },
            };
          }
        );
        scope.assertCurrent();
        const inventory: ModelAccessInventory = {
          provider,
          providerList: lists[provider] ?? [],
          catalog,
          aliases,
          accounts,
        };
        if (current()) send({ type: 'LOADED', generation, inventory });
        return current() ? inventory : null;
      } catch (error) {
        if (current()) send({ type: 'FAILED', generation, message: errorMessage(error) });
        return null;
      }
    },
    [api, owner, provider, scope, send]
  );

  // Automatic loads read the store's files and never re-list credentials, so a failing source can
  // never start a refresh loop. While this source has no files yet, re-list them exactly once per
  // provider, and only after the store runtime is running (before that, refresh() is a no-op and
  // its empty outcome would say nothing). Retrying after that is the user's explicit action.
  const storeStatus = useCredentialInventoryStore((state) => state.status);
  const listedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!provider) return;
    if (filesKey !== null) {
      void reload();
      return;
    }
    if (storeStatus === 'idle' || listedForRef.current === provider) return;
    listedForRef.current = provider;
    void reload({ credentials: true });
    // An abandoned attempt (StrictMode remount, provider switch) may list once more.
    return () => {
      listedForRef.current = null;
    };
  }, [provider, filesKey, storeStatus, reload]);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    []
  );

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
