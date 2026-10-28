import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, PoolProviderId, QuotaPool } from '@/domain/quotaPool/types';
import { PoolGraph } from './PoolGraph';
import { PoolGraphToggle } from './PoolGraphToggle';
import { PoolComparisonChart } from './PoolChart';
import type { ChartMode } from './chartGeometry';
import styles from './QuotaPoolPage.module.scss';

export function CombinedPoolCard({
  pools,
  dashboard,
  provider,
  mode,
  savedData,
}: {
  pools: QuotaPool[];
  dashboard: PoolDashboard;
  provider: PoolProviderId | 'all';
  mode: ChartMode;
  savedData: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [minimized, setMinimized] = useState(false);
  const [view, setView] = useState<'providers' | 'total'>('providers');
  const total = dashboard.combined?.[provider];
  const series =
    view === 'providers'
      ? pools
      : total?.series
        ? [{ ...total.series, provider: 'total' as const }]
        : [];
  return (
    <section className={`${styles.pool} ${styles.combined}`} aria-labelledby={`${id}-title`}>
      <div className={styles.graphHeader}>
        <h2 id={`${id}-title`}>{t('quota_pool.combined_usage')}</h2>
        <span className={styles.reorder}>
          <PoolGraphToggle
            minimized={minimized}
            onToggle={() => setMinimized((value) => !value)}
            label={t('quota_pool.combined_usage')}
            controls={`${id}-plot`}
          />
        </span>
      </div>
      <div className={styles.combinedOptions}>
        <label>
          <span className={styles.srOnly}>{t('quota_pool.series_view')}</span>
          <select value={view} onChange={(event) => setView(event.target.value as typeof view)}>
            <option value="providers">{t('quota_pool.provider_lines')}</option>
            <option value="total">{t('quota_pool.combined_total')}</option>
          </select>
        </label>
        <p className={styles.comparisonNote}>
          {t(
            view === 'providers'
              ? 'quota_pool.combined_description'
              : 'quota_pool.total_description'
          )}
        </p>
      </div>
      <PoolGraph id={`${id}-plot`} title={t('quota_pool.history_forecast')} minimized={minimized}>
        {series.length ? (
          <PoolComparisonChart
            key={`${mode}-${dashboard.fromMs}-${view}`}
            pools={series}
            dashboard={dashboard}
            mode={mode}
            minimized={minimized}
            savedData={savedData}
          />
        ) : (
          <p className={styles.stateNote} role="status">
            {t(
              total?.unavailableReason === 'ambiguous-sources'
                ? 'quota_pool.total_ambiguous'
                : 'quota_pool.total_unavailable'
            )}
          </p>
        )}
      </PoolGraph>
    </section>
  );
}
