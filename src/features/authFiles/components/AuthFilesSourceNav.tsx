import { useTranslation } from 'react-i18next';
import type { SourceView } from '@/services/providerSources/registry';
import styles from '../AuthFilesPage.module.scss';

export const ALL_SOURCES = 'all';

/**
 * Source filter for the unified Auth Files page. Every source is named with its count, so one
 * whose group starts below the fold is still discoverable; choosing one shows only its group.
 */
export function AuthFilesSourceNav({
  sources,
  counts = {},
  active = ALL_SOURCES,
  onChange,
}: {
  sources: readonly SourceView[];
  counts?: Readonly<Record<string, number>>;
  active?: string;
  onChange?: (instanceId: string) => void;
}) {
  const { t } = useTranslation();
  if (sources.length < 2) return null;
  const option = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={active === value}
      onClick={() => onChange?.(value)}
    >
      {label}
      {counts[value] !== undefined && <span className={styles.sourceCount}>{counts[value]}</span>}
    </button>
  );
  return (
    <nav className={styles.sourceNav} aria-label={t('quota_pool.runtime_source')}>
      <span>{t('quota_pool.runtime_source')}</span>
      {option(ALL_SOURCES, t('auth_files.unified_all_sources'))}
      {sources.map(({ source }) => option(source.instanceId, source.label))}
    </nav>
  );
}
