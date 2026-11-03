import { useTranslation } from 'react-i18next';
import { IconFilterAll } from '@/components/ui/icons';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import {
  ALL_PROVIDERS,
  providerColor,
  type ProviderPill,
  type ProviderSelection,
} from '../providerSelection';
import styles from './ProviderPills.module.scss';

/** Same control as the Quota page's provider bar: a group of toggle buttons. */
export function ProviderPills({
  pills,
  selected,
  onSelect,
}: {
  pills: readonly ProviderPill[];
  selected: ProviderSelection;
  onSelect: (selection: ProviderSelection) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={styles.bar}
      role="group"
      aria-label={t('dashboard.providers_label')}
      data-dashboard-pills
    >
      <button
        type="button"
        aria-pressed={selected === ALL_PROVIDERS}
        onClick={() => onSelect(ALL_PROVIDERS)}
      >
        <IconFilterAll size={18} aria-hidden="true" />
        {t('dashboard.providers_all')}
      </button>
      {pills.map((pill) => (
        <button
          type="button"
          key={pill.id}
          aria-pressed={selected === pill.id}
          title={pill.label}
          onClick={() => onSelect(pill.id)}
          style={{ '--pill-accent': providerColor(pill.brand) } as React.CSSProperties}
        >
          {pill.brand === 'claude' || pill.brand === 'codex' ? (
            <img className={styles.mark} src={PROVIDER_LOGOS[pill.brand].src} alt="" />
          ) : (
            <span className={styles.dot} aria-hidden="true" />
          )}
          {pill.name}
        </button>
      ))}
    </div>
  );
}
