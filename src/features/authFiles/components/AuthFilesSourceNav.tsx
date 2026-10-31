import { useTranslation } from 'react-i18next';
import type { SourceView } from '@/services/providerSources/registry';
import styles from '../AuthFilesPage.module.scss';

/** Sources stack vertically, so a later one starts below the fold and needs a visible entry. */
export function AuthFilesSourceNav({ sources }: { sources: readonly SourceView[] }) {
  const { t } = useTranslation();
  if (sources.length < 2) return null;
  const jumpTo = (instanceId: string) =>
    document
      .querySelector(`[data-source-id="${instanceId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <nav className={styles.sourceNav} aria-label={t('quota_pool.runtime_source')}>
      <span>{t('quota_pool.runtime_source')}</span>
      {sources.map(({ source }) => (
        <button key={source.instanceId} type="button" onClick={() => jumpTo(source.instanceId)}>
          {source.label}
        </button>
      ))}
    </nav>
  );
}
