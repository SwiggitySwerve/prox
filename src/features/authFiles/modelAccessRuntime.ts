import { createAuthFilesApi } from '@/services/api/authFiles';
import { sourceOwnerKey } from '@/services/api/sourceSession';
import { providerSources } from '@/stores/useProviderSources';
import { useCredentialInventoryStore } from '@/stores/useCredentialInventoryStore';
import {
  useModelAccessStore,
  type ModelAccessRuntime,
  type ModelAccessState,
} from '@/stores/useModelAccessStore';

/** The browser-backed runtime: reads go through the live source session's API module. */
export function createModelAccessRuntime(): ModelAccessRuntime {
  return {
    api: (owner) => {
      const key = sourceOwnerKey(owner);
      const view = providerSources
        .getSnapshot()
        .sources.find(
          (item) =>
            item.status === 'ready' && item.session && sourceOwnerKey(item.session.owner) === key
        );
      if (!view?.session) return null;
      const api = createAuthFilesApi(view.session);
      return {
        getProviderLists: () => api.getOauthExcludedModels(),
        getAliases: () => api.getOauthModelAlias(),
        getCatalog: (provider) => api.getModelDefinitions(provider),
        getAccountList: (name) => api.readAccountExcludedModels(name),
        getAccountModels: (name) => api.getModelsForAuthFile(name),
      };
    },
    now: () => Date.now(),
  };
}

let connected = false;

/**
 * The model-access store, connected to the browser on first use. Screens call this instead of
 * relying on the app shell's effects, which run after a child screen's own first effect.
 * Credentials that leave the inventory (any tab, the poll, a local delete) lose their slices.
 */
export function modelAccess(): ModelAccessState {
  if (!connected) {
    connected = true;
    useModelAccessStore.getState().configure(createModelAccessRuntime());
    useCredentialInventoryStore
      .getState()
      .registerInvalidator((owner, names) =>
        useModelAccessStore.getState().invalidateAccounts(owner, names)
      );
  }
  return useModelAccessStore.getState();
}
