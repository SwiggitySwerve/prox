import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { providerSources, useProviderSources } from '@/stores/useProviderSources';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';
import type { SourceView } from '@/services/providerSources/registry';
import { getErrorMessage } from '@/utils/helpers';
import { supportsPluginSource, resolvePluginDestination } from './pluginSourceInventory';

export interface PluginSourceProps {
  session: SourceSession;
  apiBase: string;
}

export function PluginSourceScope({
  view,
  children,
}: {
  view: SourceView;
  children: (scope: PluginSourceProps) => ReactNode;
}) {
  const { t } = useTranslation();
  const [probe, setProbe] = useState<{ done: boolean; error: string }>({ done: false, error: '' });
  const [retry, setRetry] = useState(0);
  const session = view.session;
  useEffect(() => {
    if (!session) return;
    let active = true;
    setProbe({ done: false, error: '' });
    // Re-read capabilities after the response headers have updated the registry.
    const current = providerSources.getSnapshot().sources.find((item) => item.session === session);
    const request = current
      ? supportsPluginSource(current, () => providerSources.getSnapshot().sources)
      : Promise.reject(new Error('Source is not authenticated'));
    void request.then(
      () => {
        if (active) setProbe({ done: true, error: '' });
      },
      (error: unknown) => {
        if (active) setProbe({ done: true, error: getErrorMessage(error) });
      }
    );
    return () => {
      active = false;
    };
  }, [session, retry]);

  if (!session || view.status !== 'ready') {
    return <p role="alert">{t('provider_sources.authentication_required')}</p>;
  }
  if (!probe.done) return <p role="status">{t('common.loading')}</p>;
  if (probe.error)
    return (
      <div role="alert">
        {probe.error}{' '}
        <Button onClick={() => setRetry((value) => value + 1)}>
          {t('plugin_management.refresh')}
        </Button>
      </div>
    );
  if (!view.supportsPlugin)
    return <p role="status">{t('plugin_management.unsupported_backend')}</p>;
  return children({ session, apiBase: view.source.apiBase });
}

export function PluginDestination({
  children,
  resource = false,
}: {
  children: (scope: PluginSourceProps) => ReactNode;
  resource?: boolean;
}) {
  const { t } = useTranslation();
  const registry = useProviderSources();
  const [params, setParams] = useSearchParams();
  const external = registry.resolution?.mode === 'external';
  const view = resolvePluginDestination(
    registry.sources,
    params.get('source'),
    external,
    registry.resolution?.selectedInstanceId
  );

  if (registry.status === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (registry.status !== 'ready')
    return <p role="alert">{t('provider_sources.discovery_error')}</p>;
  if (resource && !external)
    return <p role="alert">{t('plugin_resource.source_embedding_unsupported')}</p>;
  return (
    <>
      {!resource && (
        <label>
          {t('plugin_store.destination')}
          <Select
            ariaLabel={t('plugin_store.destination')}
            placeholder={t('plugin_store.select_destination')}
            value={view?.source.instanceId ?? ''}
            options={registry.sources.map((item) => ({
              value: item.source.instanceId,
              label: item.source.label,
            }))}
            onChange={(source) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set('source', source);
                return next;
              })
            }
          />
        </label>
      )}
      {view ? (
        <PluginSourceScope
          key={view.session ? sourceOwnerKey(view.session.owner) : view.source.instanceId}
          view={view}
        >
          {children}
        </PluginSourceScope>
      ) : (
        <p role="status">{t('plugin_store.select_destination')}</p>
      )}
    </>
  );
}
