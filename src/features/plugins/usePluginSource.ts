import { useMemo } from 'react';
import { useSourceLease } from '@/hooks/useSourceLease';
import type { SourceSession } from '@/services/api/sourceSession';
import { useNotificationStore } from '@/stores/useNotificationStore';

/** Global confirmations must not outlive the plugin view that opened them. */
export function usePluginSource(owner: SourceSession) {
  const lease = useSourceLease(owner);
  const notify = useNotificationStore((state) => state.showNotification);
  const confirm = useNotificationStore((state) => state.showConfirmation);
  return useMemo(
    () => ({
      ...lease,
      showNotification: (...args: Parameters<typeof notify>) => {
        if (lease.isCurrent()) notify(...args);
      },
      showConfirmation: (options: Parameters<typeof confirm>[0]) => {
        if (!lease.isCurrent()) return;
        const revision = lease.getRevision();
        confirm({
          ...options,
          onConfirm: async () => {
            if (lease.getRevision() !== revision) return;
            await options.onConfirm();
          },
        });
      },
    }),
    [lease, notify, confirm]
  );
}
