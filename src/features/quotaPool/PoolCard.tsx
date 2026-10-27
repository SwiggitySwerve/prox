import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import type { ChartMode } from './chartGeometry';
import { PoolChart } from './PoolChart';
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
            <span className={styles.providerMark} aria-hidden="true">
              {pool.provider === 'claude' ? '✳' : '⌘'}
            </span>
            <h2 id={`${pool.provider}-title`}>{t(`quota_pool.${pool.provider}`)}</h2>
            <span>{t('quota_pool.account_count', { count: pool.accountCount })}</span>
            <span className={styles.badge}>{t(`quota_pool.state.${pool.forecastState}`)}</span>
          </div>
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
              {number(pool.burnPointsPerHour)} <small>{t('quota_pool.points_hour')}</small>
            </dd>
          </div>
        </dl>
      </div>
      {pool.forecastState !== 'ready' && (
        <p className={styles.stateNote}>{t(`quota_pool.state_note.${pool.forecastState}`)}</p>
      )}
      <PoolChart
        key={`${mode}-${dashboard.fromMs}`}
        pool={pool}
        dashboard={dashboard}
        mode={mode}
      />
      <details className={styles.accounts}>
        <summary>
          {t('quota_pool.accounts')} <span>{pool.accountCount}</span>
        </summary>
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
      </details>
    </article>
  );
}
