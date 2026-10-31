import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPoolNumber } from './presentation';
import type { PoolDashboard, PoolProviderId, QuotaPool } from '@/domain/quotaPool/types';
import { poolKey } from './poolOrder';
import { PoolGraph } from './PoolGraph';
import { PoolGraphToggle } from './PoolGraphToggle';
import { PoolComparisonChart } from './PoolChart';
import { metricField, type ChartMode } from './chartGeometry';
import styles from './QuotaPoolPage.module.scss';

export function CombinedPoolCard({
  pools,
  dashboard,
  provider,
  mode,
  savedData,
  reveal = false,
  onRefresh,
}: {
  pools: QuotaPool[];
  dashboard: PoolDashboard;
  provider: PoolProviderId | 'all';
  mode: ChartMode;
  savedData: boolean;
  reveal?: boolean;
  /** The page's one "Refresh now", beside a partial or stale notice. */
  onRefresh?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [minimized, setMinimized] = useState(false);
  const [view, setView] = useState<'providers' | 'stacked'>('stacked');
  const total = dashboard.combined?.[provider];
  // Without a server total there is nothing to stack; each provider's own line still is.
  const stackable = Boolean(total?.layers && total.series);
  const shownView = stackable ? view : 'providers';
  const series =
    shownView === 'providers'
      ? pools
      : pools.flatMap((pool) => total!.layers!.filter((layer) => poolKey(layer) === poolKey(pool)));
  const headline = total?.series ? total.series[metricField[mode]] : null;
  const windowLabel = t(`quota_pool.${dashboard.window === 'weekly' ? 'weekly' : 'five_hour'}`);
  // Name the accounts that hold the total back, as each provider card does.
  const accounts = pools.flatMap((pool) => pool.accounts);
  const names = (status: (typeof accounts)[number]['status'][]) => {
    const named = accounts
      .filter((account) => status.includes(account.status))
      .map((account) =>
        reveal && account.email ? account.email : (account.identifier ?? account.label)
      );
    return [...named.slice(0, 3), ...(named.length > 3 ? [`+${named.length - 3}`] : [])].join(', ');
  };
  const stateNote = (state: string) => {
    const missing = names(['error', 'missing-window']);
    const stale = names(['stale']);
    if (state === 'partial' && missing)
      return t('quota_pool.unavailable_named', { names: missing });
    if (state === 'stale' && stale) return t('quota_pool.stale_named', { names: stale });
    return t(`quota_pool.state_note.${state}`, { window: windowLabel });
  };
  return (
    <section className={`${styles.pool} ${styles.combined}`} aria-labelledby={`${id}-title`}>
      <div className={styles.graphHeader}>
        <h2 id={`${id}-title`}>{t('quota_pool.combined_usage')}</h2>
        {/* The chart's view control sits on the card's title row, next to the chart toggle. */}
        <div className={styles.combinedOptions}>
          <label>
            <span className={styles.srOnly}>{t('quota_pool.series_view')}</span>
            <select
              value={shownView}
              onChange={(event) => setView(event.target.value as typeof view)}
            >
              <option value="providers">{t('quota_pool.provider_lines')}</option>
              <option value="stacked" disabled={!stackable}>
                {t('quota_pool.stacked_providers')}
              </option>
            </select>
          </label>
        </div>
        <span className={styles.reorder}>
          <PoolGraphToggle
            minimized={minimized}
            onToggle={() => setMinimized((value) => !value)}
            label={t('quota_pool.combined_usage')}
            controls={`${id}-plot`}
          />
        </span>
      </div>
      {/* Same headline block as a provider card, so an unavailable total keeps its caption. */}
      <div
        className={styles.headline}
        data-unavailable={headline === null}
        data-rate={mode !== 'remaining'}
      >
        <strong>
          {/* Same as the provider cards: the value slot says the total is missing. */}
          {headline === null ? (
            <span className={styles.unavailableValue}>{t('quota_pool.value_unavailable')}</span>
          ) : (
            formatPoolNumber(headline, i18n.language)
          )}
          {mode !== 'remaining' && headline !== null && (
            <small> {t('quota_pool.points_hour')}</small>
          )}
        </strong>
        <div className={styles.headlineContext}>
          <p className={styles.metricLabel}>
            {mode !== 'remaining'
              ? t('quota_pool.recorded_rate', {
                  rate: t(`quota_pool.${mode}`),
                  hours: dashboard.lookbackHours,
                })
              : t('quota_pool.window_remaining', { window: windowLabel })}
          </p>
          {mode === 'remaining' && total?.series && (
            <span>
              {t('quota_pool.of_capacity', {
                capacity: formatPoolNumber(total.series.capacityPoints, i18n.language),
              })}
            </span>
          )}
        </div>
      </div>
      {/* Partial or stale data withholds the total; say why under the headline, as the provider cards do. */}
      {headline === null && total?.series && total.series.forecastState !== 'ready' && (
        <p className={styles.stateNote} role="status" data-state={total.series.forecastState}>
          <span>{stateNote(total.series.forecastState)}</span>
          {onRefresh &&
            (total.series.forecastState === 'partial' ||
              total.series.forecastState === 'stale') && (
              <button type="button" className={styles.noteAction} onClick={onRefresh}>
                {t('quota_pool.refresh_now')}
              </button>
            )}
        </p>
      )}
      {/* Why there is no total to stack, under the headline it explains. */}
      {!stackable && (
        <p className={styles.stateNote} role="status">
          {t(
            total?.unavailableReason === 'ambiguous-sources'
              ? 'quota_pool.total_ambiguous'
              : 'quota_pool.total_unavailable'
          )}
        </p>
      )}
      <PoolGraph id={`${id}-plot`} title={t('quota_pool.history_forecast')} minimized={minimized}>
        {series.length > 0 && (
          <PoolComparisonChart
            key={`${mode}-${dashboard.fromMs}-${shownView}`}
            pools={series}
            stackedTotal={shownView === 'stacked' ? (total?.series ?? undefined) : undefined}
            dashboard={dashboard}
            mode={mode}
            minimized={minimized}
            savedData={savedData}
          />
        )}
      </PoolGraph>
    </section>
  );
}
