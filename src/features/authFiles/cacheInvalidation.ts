import { useQuotaStore, type QuotaStore } from '@/stores/useQuotaStore';

type ModelsInvalidator = (names?: string[]) => void;

/** Invalidate every cache whose contents depend on an auth file's credentials. */
export const invalidateAuthFileDerivedCaches = (
  invalidateModels: ModelsInvalidator,
  names?: string[],
  quotaStore: QuotaStore = useQuotaStore
): void => {
  invalidateModels(names);
  quotaStore.getState().clearQuotaCache(names);
};
