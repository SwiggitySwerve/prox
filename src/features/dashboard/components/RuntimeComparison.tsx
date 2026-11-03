import { useTranslation } from 'react-i18next';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import type { DashboardSource } from '../providerSelection';
import dashboardStyles from '../dashboard.module.scss';
import styles from './RuntimeComparison.module.scss';

const DASH = '—';

export interface RuntimeRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface RuntimeToggle {
  label: string;
  on: boolean;
}

/** Settings belong to each source, so several sources compare side by side. */
export function RuntimeComparison({
  sources,
  rows,
  toggles,
}: {
  sources: DashboardSource[];
  rows: (source: DashboardSource) => RuntimeRow[];
  toggles: (source: DashboardSource) => RuntimeToggle[];
}) {
  const { t } = useTranslation();
  const configured = sources.find((source) => source.config);
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">{t('dashboard.runtime_setting')}</th>
          {sources.map((source) => (
            <th key={source.id} scope="col" title={source.label}>
              <span className={styles.source}>
                {(source.brand === 'claude' || source.brand === 'codex') && (
                  <img className={styles.mark} src={PROVIDER_LOGOS[source.brand].src} alt="" />
                )}
                {source.name}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows(sources[0]).map((row, index) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            {sources.map((source) => (
              <td key={source.id} className={row.mono ? dashboardStyles.specMono : undefined}>
                {rows(source)[index].value}
              </td>
            ))}
          </tr>
        ))}
        {configured &&
          toggles(configured).map((toggle, index) => (
            <tr key={toggle.label}>
              <th scope="row">{toggle.label}</th>
              {sources.map((source) => {
                const own = toggles(source)[index];
                return (
                  <td key={source.id}>
                    {own ? (
                      <span
                        className={`${dashboardStyles.togglePill} ${styles.pill} ${own.on ? dashboardStyles.toggleOn : dashboardStyles.toggleOff}`}
                      >
                        <b>{own.on ? t('common.yes') : t('common.no')}</b>
                      </span>
                    ) : (
                      DASH
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
      </tbody>
    </table>
  );
}
