import { selectSource } from '@/services/providerSources/selection';
import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProviderSources } from '@/stores/useProviderSources';
import { AuthFilesSourceProvider } from '@/features/authFiles/AuthFilesSourceContext';
import { type SourceOwner } from '@/services/api/sourceSession';

/** A direct link resolves once; navigation from an account also pins the originating session. */
export function AuthFileEditorBoundary({ children }: { children: ReactNode }) {
  const registry = useProviderSources();
  const [params] = useSearchParams();
  const location = useLocation();
  const { t } = useTranslation();
  if (registry.status === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (registry.status !== 'ready')
    return <p role="alert">{t('provider_sources.discovery_error')}</p>;
  const owner = (location.state as { sourceOwner?: SourceOwner } | null)?.sourceOwner;
  const view = selectSource(registry, params.get('source'), owner);
  if (!view) {
    return <p role="alert">{t('provider_sources.authentication_required')}</p>;
  }
  return (
    <AuthFilesSourceProvider source={view.source} session={view.session}>
      {children}
    </AuthFilesSourceProvider>
  );
}
