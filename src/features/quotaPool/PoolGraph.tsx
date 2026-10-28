import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import styles from './QuotaPoolPage.module.scss';

/** Shared presentation control: shrinking a graph never hides accounts or changes its data. */
export function PoolGraph({
  title,
  label = title,
  children,
}: {
  title: string;
  label?: string;
  children: (minimized: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [minimized, setMinimized] = useState(false);
  const Icon = minimized ? IconChevronDown : IconChevronUp;
  return (
    <section className={styles.forecast} aria-labelledby={`${id}-title`} data-minimized={minimized}>
      <div className={styles.graphHeader}>
        <h3 id={`${id}-title`}>{title}</h3>
        <button
          type="button"
          aria-pressed={minimized}
          aria-controls={`${id}-plot`}
          aria-label={t(
            minimized ? 'quota_pool.expand_graph_label' : 'quota_pool.minimize_graph_label',
            { graph: label }
          )}
          onClick={() => setMinimized((value) => !value)}
        >
          <Icon size={16} aria-hidden="true" />
          {t(minimized ? 'quota_pool.expand_graph' : 'quota_pool.minimize_graph')}
        </button>
      </div>
      <div id={`${id}-plot`}>{children(minimized)}</div>
    </section>
  );
}
