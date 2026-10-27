import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/useAuthStore';
import type { PoolProviderId } from '@/domain/quotaPool/types';
import { managementRuntime } from './runtimeConnection';
import { PoolProviderMark } from './PoolProviderMark';
import styles from './ManagementRuntime.module.scss';

export function ManagementRuntime() {
  const { t } = useTranslation();
  const { apiBase, managementKey, rememberPassword, connectionStatus, login } = useAuthStore();
  const [error, setError] = useState(false);
  const runtime = managementRuntime(apiBase, window.location.origin);
  if (!runtime) return null;

  const switchTo = async (provider: PoolProviderId) => {
    if (connectionStatus === 'connecting' || provider === runtime.provider) return;
    setError(false);
    try {
      await login({ apiBase: runtime.baseFor(provider), managementKey, rememberPassword });
    } catch {
      // Restore the previous connection only if this attempt still owns the failed session.
      const current = useAuthStore.getState();
      if (
        current.isAuthenticated &&
        current.connectionStatus === 'error' &&
        current.apiBase === apiBase &&
        current.managementKey === managementKey
      ) {
        try {
          await login({ apiBase, managementKey, rememberPassword });
        } catch {
          /* The retry remains visible. */
        }
      }
      setError(true);
    }
  };

  return (
    <section className={styles.scope} aria-label={t('quota_pool.runtime_source')}>
      <div className={styles.controls} role="group" aria-label={t('quota_pool.runtime_source')}>
        <span>{t('quota_pool.runtime_source')}</span>
        {(['codex', 'claude'] as const).map((provider) => (
          <button
            type="button"
            key={provider}
            aria-pressed={runtime.provider === provider}
            disabled={connectionStatus === 'connecting'}
            onClick={() => void switchTo(provider)}
          >
            <PoolProviderMark provider={provider} />
            {t(`quota_pool.${provider}`)}
          </button>
        ))}
      </div>
      <p role="status">
        {t(
          connectionStatus === 'connecting'
            ? 'quota_pool.runtime_switching'
            : 'quota_pool.runtime_scope',
          { provider: t(`quota_pool.${runtime.provider}`) }
        )}
      </p>
      {error && <p role="alert">{t('quota_pool.runtime_switch_error')}</p>}
    </section>
  );
}
