import { useLayoutEffect, useMemo } from 'react';
import { createSourceLease } from '@/services/api/sourceLease';
import type { SourceSession } from '@/services/api/sourceSession';

/** Cancel delayed view operations without changing the registry's authenticated session. */
export function useSourceLease(owner: SourceSession) {
  const lease = useMemo(() => createSourceLease(owner), [owner]);
  useLayoutEffect(() => {
    lease.activate();
    return lease.dispose;
  }, [lease]);
  return lease;
}
