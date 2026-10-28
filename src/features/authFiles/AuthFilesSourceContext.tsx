import { createQuotaAdapters } from '@/features/quota/providers';
import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { ResolvedSource } from '@/domain/providerSources/types';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { createAuthFilesSourceScope } from './sourceScope';

type SourceContext = ReturnType<typeof createAuthFilesSourceScope> & {
  readonly source: ResolvedSource;
  readonly quotaAdapters: ReturnType<typeof createQuotaAdapters>;
};
const AuthFilesSourceContext = createContext<SourceContext | null>(null);

export function AuthFilesSourceProvider(props: {
  source: ResolvedSource;
  session: SourceSession;
  children: ReactNode;
}) {
  // Also remount all feature state on a replacement session, including an A -> B -> A change.
  return <SourceProviderLifetime key={sourceOwnerKey(props.session.owner)} {...props} />;
}

function SourceProviderLifetime({
  source,
  session,
  children,
}: {
  source: ResolvedSource;
  session: SourceSession;
  children: ReactNode;
}) {
  const scope = useMemo(() => createAuthFilesSourceScope(session), [session]);
  useLayoutEffect(() => {
    scope.activate();
    return scope.dispose;
  }, [scope]);
  const quotaAdapters = useMemo(
    () => createQuotaAdapters(scope.session, scope.quotaStore),
    [scope]
  );
  const value = useMemo(
    () => ({ ...scope, source, quotaAdapters }),
    [scope, source, quotaAdapters]
  );
  return (
    <AuthFilesSourceContext.Provider value={value}>{children}</AuthFilesSourceContext.Provider>
  );
}

export function useAuthFilesSource() {
  const source = useContext(AuthFilesSourceContext);
  if (!source) throw new Error('Auth files requires an owning source');
  return source;
}

/** Global dialogs retain the originating view even after navigation or source removal. */
export function useAuthFilesNotifications() {
  const scope = useAuthFilesSource();
  const notify = useNotificationStore((state) => state.showNotification);
  const confirm = useNotificationStore((state) => state.showConfirmation);
  return useMemo(
    () => ({
      showNotification: (...[message, ...rest]: Parameters<typeof notify>) => {
        if (scope.isCurrent()) notify(`${scope.source.label}: ${message}`, ...rest);
      },
      showConfirmation: (options: Parameters<typeof confirm>[0]) => {
        if (!scope.isCurrent()) return;
        const revision = scope.getRevision();
        confirm({
          ...options,
          title: options.title ? `${scope.source.label} · ${options.title}` : scope.source.label,
          onConfirm: async () => {
            if (!scope.isCurrent() || scope.getRevision() !== revision) return;
            await options.onConfirm();
          },
        });
      },
    }),
    [scope, notify, confirm]
  );
}
