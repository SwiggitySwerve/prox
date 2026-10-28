import { useNavigate, useSearchParams } from 'react-router-dom';
import { selectSource } from '@/services/providerSources/selection';
import { useTranslation } from 'react-i18next';
import { useProviderSources } from '@/stores/useProviderSources';
import styles from './ManagementRuntime.module.scss';

/** Explicit destination for source-local tools; inventory pages enumerate the same registry. */
export function ManagementRuntime() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const registry = useProviderSources();
  if (registry.status === 'loading')
    return <p role="status">{t('quota_pool.runtime_switching')}</p>;
  if (registry.status === 'error')
    return <p role="alert">{t('provider_sources.discovery_error')}</p>;
  const resolution = registry.resolution;
  if (!resolution || resolution.sources.length < 2) return null;
  const selected = selectSource(registry, params.get('source'));
  return (
    <section className={styles.scope} aria-label={t('quota_pool.runtime_source')}>
      <div className={styles.controls} role="group" aria-label={t('quota_pool.runtime_source')}>
        <span>{t('quota_pool.runtime_source')}</span>
        {resolution.sources.map((source) => (
          <button
            type="button"
            key={source.instanceId}
            aria-pressed={selected?.source.instanceId === source.instanceId}
            disabled={!selectSource(registry, source.instanceId)}
            title={
              !selectSource(registry, source.instanceId)
                ? t('provider_sources.authentication_required')
                : undefined
            }
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('source', source.instanceId);
              navigate({ search: next.toString() }, { state: null });
            }}
          >
            {source.label}
          </button>
        ))}
      </div>
      {selected ? (
        <p role="status">{t('quota_pool.runtime_scope', { provider: selected.source.label })}</p>
      ) : (
        <p role="alert">{t('provider_sources.authentication_required')}</p>
      )}
    </section>
  );
}
