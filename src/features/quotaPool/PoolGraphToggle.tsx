import { useTranslation } from 'react-i18next';
import { IconMaximize2, IconMinimize2 } from '@/components/ui/icons';
import styles from './QuotaPoolPage.module.scss';

export function PoolGraphToggle({
  minimized,
  onToggle,
  label,
  controls,
}: {
  minimized: boolean;
  onToggle: () => void;
  label: string;
  controls: string;
}) {
  const { t } = useTranslation();
  const Icon = minimized ? IconMaximize2 : IconMinimize2;
  const action = t(
    minimized ? 'quota_pool.expand_graph_label' : 'quota_pool.minimize_graph_label',
    { graph: label }
  );
  return (
    <button
      type="button"
      className={styles.graphToggle}
      title={action}
      aria-label={action}
      aria-pressed={minimized}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
