import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import { metricField, type ChartMode } from './chartGeometry';
import { PoolChart } from './PoolChart';
import { PoolProviderMark } from './PoolProviderMark';
import { formatPoolDate, formatPoolNumber } from './presentation';
import styles from './QuotaPoolPage.module.scss';

export function PoolCard({
  pool,
  dashboard,
  mode,
  reveal,
}: {
  pool: QuotaPool;
  dashboard: PoolDashboard;
  mode: ChartMode;
  reveal: boolean;
}) {
  const { t, i18n } = useTranslation();
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number | null) => formatPoolDate(value, i18n.language);
  const forecastDate = (value: number | null) =>
    value === null ? t('quota_pool.not_predicted') : date(value);
  return (
    <article
      className={`${styles.pool} ${styles[pool.provider]}`}
      aria-labelledby={`${pool.provider}-title`}
      data-forecast-state={pool.forecastState}
    >
      <div className={styles.poolHeader}>
        <div className={styles.poolIdentity}>
          <div className={styles.poolTitle}>
            <PoolProviderMark provider={pool.provider} />
            <h2 id={`${pool.provider}-title`}>{t(`quota_pool.${pool.provider}`)}</h2>
            <span>{t('quota_pool.account_count', { count: pool.accountCount })}</span>
          </div>
          <p className={styles.metricLabel}>
            {mode !== 'remaining'
              ? t(`quota_pool.${mode}`)
              : t('quota_pool.window_remaining', {
                  window: t(`quota_pool.${dashboard.window === 'weekly' ? 'weekly' : 'five_hour'}`),
                })}
          </p>
          <div className={styles.headline}>
            <strong>{number(pool[metricField[mode]])}</strong>
            <span>
              {mode === 'remaining'
                ? t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })
                : t('quota_pool.points_hour')}
            </span>
          </div>
          <p className={styles.coverage}>
            {t('quota_pool.coverage', { loaded: pool.loadedCount, eligible: pool.eligibleCount })}
            <span className={styles.badge}>
              {t('quota_pool.forecast_status', {
                state: t(`quota_pool.state.${pool.forecastState}`),
              })}
            </span>
          </p>
          {pool.forecastState === 'stale' && (
            <p className={styles.coverage}>
              {t('quota_pool.last_refresh')}: {date(dashboard.lastRefreshAtMs)}
            </p>
          )}
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>{t('quota_pool.pool_empty')}</dt>
            <dd>{forecastDate(pool.poolEmptyAtMs)}</dd>
          </div>
          <div>
            <dt>{t('quota_pool.first_empty')}</dt>
            <dd>{forecastDate(pool.firstEmptyAtMs)}</dd>
          </div>
          <div>
            <dt>{t('quota_pool.next_reset')}</dt>
            <dd>{date(pool.nextResetAtMs)}</dd>
            {pool.nextResetGainPoints !== null && (
              <small>
                +{number(pool.nextResetGainPoints)} {t('quota_pool.points')}
              </small>
            )}
          </div>
          <div>
            <dt>{t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}</dt>
            <dd>
              {number(pool.burnPointsPerHour)} {t('quota_pool.points_hour')}
            </dd>
          </div>
        </dl>
      </div>
      {pool.forecastState !== 'ready' && (
        <p className={styles.stateNote} role="status" data-state={pool.forecastState}>
          {t(`quota_pool.state_note.${pool.forecastState}`)}
        </p>
      )}
      <section className={styles.forecast} aria-label={t('quota_pool.history_forecast')}>
        <PoolChart
          key={`${mode}-${dashboard.fromMs}`}
          pool={pool}
          dashboard={dashboard}
          mode={mode}
        />
      </section>
      <section className={styles.accounts} aria-labelledby={`${pool.provider}-accounts`}>
        <h3 id={`${pool.provider}-accounts`}>
          {t('quota_pool.accounts')} <span>{pool.accountCount}</span>
        </h3>
        <div className={styles.accountGrid}>
          {pool.accounts.length === 0 ? (
            <p className={styles.stateNote}>{t('quota_pool.state_note.no-accounts')}</p>
          ) : (
            pool.accounts.map((account) => (
              <details key={account.id} className={styles.account} data-status={account.status}>
                <summary>
                  <span className={styles.accountName}>
                    {reveal && account.email ? account.email : account.label}
                  </span>
                  <span className={styles.accountStatus}>
                    {t(`quota_pool.account_status.${account.status}`)}
                  </span>
                  <strong>
                    {account.remainingPercent === null
                      ? '—'
                      : `${number(account.remainingPercent)}%`}
                  </strong>
                </summary>
                <dl className={styles.accountDetails}>
                  <div>
                    <dt>{t('quota_pool.observed')}</dt>
                    <dd>{date(account.observedAtMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('quota_pool.next_reset')}</dt>
                    <dd>{date(account.resetAtMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('quota_pool.first_empty')}</dt>
                    <dd>{forecastDate(account.emptyAtMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('quota_pool.burn')}</dt>
                    <dd>
                      {number(account.burnPointsPerHour)} {t('quota_pool.points_hour')}
                    </dd>
                  </div>
                </dl>
              </details>
            ))
          )}
        </div>
      </section>
    </article>
  );
}
