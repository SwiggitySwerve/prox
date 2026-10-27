import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import type { ChartMode } from './chartGeometry';
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
    >
      <div className={styles.poolHeader}>
        <div>
          <div className={styles.poolTitle}>
            <PoolProviderMark provider={pool.provider} />
            <h2 id={`${pool.provider}-title`}>{t(`quota_pool.${pool.provider}`)}</h2>
            <span>{t('quota_pool.account_count', { count: pool.accountCount })}</span>
          </div>
          <p className={styles.coverage}>
            {t('quota_pool.window_remaining', {
              window: t(`quota_pool.${dashboard.window === 'weekly' ? 'weekly' : 'five_hour'}`),
            })}
          </p>
          <div className={styles.headline}>
            <strong>{number(pool.remainingPoints)}</strong>
            <span>{t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}</span>
          </div>
          <p className={styles.coverage}>
            {t('quota_pool.coverage', { loaded: pool.loadedCount, eligible: pool.eligibleCount })}
          </p>
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>{t('quota_pool.next_reset')}</dt>
            <dd>{date(pool.nextResetAtMs)}</dd>
          </div>
        </dl>
      </div>
      {pool.forecastState !== 'ready' && (
        <p className={styles.stateNote}>{t(`quota_pool.state_note.${pool.forecastState}`)}</p>
      )}
      <section className={styles.accounts} aria-labelledby={`${pool.provider}-accounts`}>
        <h3 id={`${pool.provider}-accounts`}>
          {t('quota_pool.accounts')} <span>{pool.accountCount}</span>
        </h3>
        {pool.accounts.length === 0 ? (
          <p className={styles.stateNote}>{t('quota_pool.state_note.no-accounts')}</p>
        ) : (
          pool.accounts.map((account) => (
            <details key={account.id} className={styles.account}>
              <summary>
                <span className={styles.accountName}>
                  {reveal && account.email ? account.email : account.label}
                </span>
                <span className={styles.accountStatus}>
                  {t(`quota_pool.account_status.${account.status}`)}
                </span>
                <strong>
                  {account.remainingPercent === null ? '—' : `${number(account.remainingPercent)}%`}
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
      </section>
      <details className={styles.forecast}>
        <summary>
          {t('quota_pool.history_forecast')}
          <span className={styles.badge}>
            {t('quota_pool.forecast_status', {
              state: t(`quota_pool.state.${pool.forecastState}`),
            })}
          </span>
        </summary>
        <dl className={styles.forecastStats}>
          <div>
            <dt>{t('quota_pool.pool_empty')}</dt>
            <dd>{forecastDate(pool.poolEmptyAtMs)}</dd>
          </div>
          <div>
            <dt>{t('quota_pool.first_empty')}</dt>
            <dd>{forecastDate(pool.firstEmptyAtMs)}</dd>
          </div>
          <div>
            <dt>{t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}</dt>
            <dd>
              {number(pool.burnPointsPerHour)} {t('quota_pool.points_hour')}
            </dd>
          </div>
        </dl>
        <PoolChart
          key={`${mode}-${dashboard.fromMs}`}
          pool={pool}
          dashboard={dashboard}
          mode={mode}
        />
      </details>
    </article>
  );
}
