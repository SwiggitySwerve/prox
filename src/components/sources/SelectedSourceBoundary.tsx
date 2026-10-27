import { useSourceLease } from '@/hooks/useSourceLease';
import { useLocation, useSearchParams } from 'react-router-dom';
import { selectSource } from '@/services/providerSources/selection';
import type { SourceOwner } from '@/services/api/sourceSession';
import { createContext, useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderSources } from '@/stores/useProviderSources';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';

const SelectedSourceContext = createContext<SourceSession | null>(null);
export function useSelectedSourceSession(): SourceSession {
  const session = useContext(SelectedSourceContext);
  if (!session) throw new Error('Source-owned page requires a source boundary');
  return session;
}
export function SelectedSourceBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const registry = useProviderSources();
  const [params] = useSearchParams();
  const location = useLocation();
  if (registry.status === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (registry.status !== 'ready')
    return <p role="alert">{t('provider_sources.discovery_error')}</p>;
  const source = selectSource(
    registry,
    params.get('source'),
    (location.state as { sourceOwner?: SourceOwner } | null)?.sourceOwner
  );
  if (!source) return <p role="alert">{t('provider_sources.authentication_required')}</p>;
  return (
    // MainLayout's source toolbar names the destination for these routes.
    <SourceDestination key={sourceOwnerKey(source.session.owner)} session={source.session}>
      {children}
    </SourceDestination>
  );
}

function SourceDestination({ session, children }: { session: SourceSession; children: ReactNode }) {
  const lease = useSourceLease(session);
  return (
    <SelectedSourceContext.Provider value={lease.session}>
      {children}
    </SelectedSourceContext.Provider>
  );
}
