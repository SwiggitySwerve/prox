import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { getTypeLabel, type OAuthConfigLoadError } from '@/features/authFiles/constants';
import type { OAuthModelAliasEntry } from '@/types';
import styles from '../AuthFilesPage.module.scss';

export type ModelAccessSummaryProps = {
  /** Providers that have credentials on this source. */
  providers: string[];
  excluded: Record<string, string[]>;
  excludedError: OAuthConfigLoadError;
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  onRetry: () => void;
  onOpen: (provider: string) => void;
};

/**
 * Per source, one row per provider: how many provider rules and aliases exist, and the way into
 * the Models screen, where the effective state per account is shown and edited.
 *
 * OAuth config load (machine M3, docs/design/auth-files-models-plan.md): `OAuthConfigLoadError`
 * is a status despite its name: 'loading' | 'load' (failed) | 'unsupported' | null (ready).
 * Counts are shown only when ready, so a failed reload never shows stale numbers as current.
 */
export function ModelAccessSummary(props: ModelAccessSummaryProps) {
  const { t } = useTranslation();
  const { excludedError } = props;
  const state = excludedError ?? 'ready';
  const providers = Array.from(
    new Set([...props.providers, ...Object.keys(props.excluded), ...Object.keys(props.modelAlias)])
  ).sort();

  return (
    <section
      className={styles.accessSummary}
      aria-label={t('model_access.summary_title')}
      data-machine="oauth-config"
      data-state={state}
    >
      <h3>{t('model_access.summary_title')}</h3>
      {excludedError === 'loading' ? (
        <p role="status">{t('model_access.summary_loading')}</p>
      ) : excludedError === 'unsupported' ? (
        <p>{t('model_access.summary_unsupported')}</p>
      ) : excludedError === 'load' ? (
        <p role="alert" className={styles.summaryError}>
          {t('model_access.summary_error')}{' '}
          <Button variant="secondary" size="sm" onClick={props.onRetry}>
            {t('model_access.retry_load')}
          </Button>
        </p>
      ) : (
        <ul>
          {providers.map((provider) => (
            <li key={provider}>
              <strong>{getTypeLabel(t, provider)}</strong>
              <span>
                {t('model_access.summary_rules', { count: props.excluded[provider]?.length ?? 0 })}
              </span>
              <span>
                {t('model_access.summary_aliases', {
                  count: props.modelAlias[provider]?.length ?? 0,
                })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => props.onOpen(provider)}
                aria-label={`${t('model_access.open_models')} · ${getTypeLabel(t, provider)}`}
              >
                {t('model_access.open_models')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
