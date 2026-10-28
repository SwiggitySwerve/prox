import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { ResolvedSource } from '@/domain/providerSources/types';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { createProviderSourceScope, type ProviderSourceScope } from './sourceScope';

const ProviderSourceContext = createContext<ProviderSourceScope | null>(null);

export function ProviderSourceProvider(props: {
  source: ResolvedSource;
  session: SourceSession;
  children: ReactNode;
}) {
  return <ProviderSourceLifetime key={sourceOwnerKey(props.session.owner)} {...props} />;
}

function ProviderSourceLifetime({
  source,
  session,
  children,
}: {
  source: ResolvedSource;
  session: SourceSession;
  children: ReactNode;
}) {
  const scope = useMemo(() => createProviderSourceScope(session, source), [session, source]);
  useLayoutEffect(() => {
    scope.activate();
    return scope.dispose;
  }, [scope]);
  return <ProviderSourceContext.Provider value={scope}>{children}</ProviderSourceContext.Provider>;
}

export function useOptionalProviderSource() {
  return useContext(ProviderSourceContext);
}

export function useProviderSource() {
  const scope = useOptionalProviderSource();
  if (!scope) throw new Error('Providers require an owning source');
  return scope;
}

export function useProviderNotifications() {
  const scope = useProviderSource();
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
          title: `${scope.source.label} · ${options.title ?? ''}`,
          onConfirm: async () => {
            scope.assertCurrent();
            if (revision !== scope.getRevision()) throw new Error('Source view changed');
            await options.onConfirm();
          },
        });
      },
    }),
    [scope, notify, confirm]
  );
}
