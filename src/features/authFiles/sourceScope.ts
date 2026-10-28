import { createQuotaStore } from '@/stores/useQuotaStore';
import { createAuthFilesApi } from '@/services/api/authFiles';
import { createSourceLease } from '@/services/api/sourceLease';
import type { SourceSession } from '@/services/api/sourceSession';

/** Feature state is private to a mounted source view; domain rules stay in the factories. */
export function createAuthFilesSourceScope(owner: SourceSession) {
  const lease = createSourceLease(owner);
  const quotaStore = createQuotaStore();
  return Object.freeze({
    ...lease,
    quotaStore,
    api: createAuthFilesApi(lease.session),
    dispose: () => {
      lease.dispose();
      quotaStore.getState().clearQuotaCache();
    },
  });
}
