import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import { metricField, type ChartMode } from './chartGeometry';
import { PoolChart } from './PoolChart';
import { PoolGraph } from './PoolGraph';
import { PoolGraphToggle } from './PoolGraphToggle';
import { PoolProviderMark } from './PoolProviderMark';
import { formatPoolDate, formatPoolNumber } from './presentation';
import styles from './QuotaPoolPage.module.scss';

export function PoolCard({
  pool,
  dashboard,
  mode,
  reveal,
  savedData = false,
  move,
}: {
  pool: QuotaPool;
  dashboard: PoolDashboard;
  mode: ChartMode;
  reveal: boolean;
  savedData?: boolean;
  /** Reorder controls; a missing direction is shown disabled. */
  move?: { up?: () => void; down?: () => void };
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [minimized, setMinimized] = useState(false);
  // Collapsed accounts show limits as numbers only; opening one shows bars and reset times.
  const [openAccounts, setOpenAccounts] = useState<ReadonlySet<string>>(() => new Set());
  const allOpen = pool.accounts.length > 0 && pool.accounts.every((a) => openAccounts.has(a.id));
  const setAccountOpen = (accountId: string, open: boolean) =>
    setOpenAccounts((current) => {
      if (current.has(accountId) === open) return current;
      const next = new Set(current);
      if (open) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number | null) => formatPoolDate(value, i18n.language);
  const forecastDate = (value: number | null, available = pool.forecastState === 'ready') =>
    value === null
      ? t(`quota_pool.${available ? 'not_predicted' : 'forecast_unavailable'}`)
      : date(value);
  const windowLabel = t(`quota_pool.${dashboard.window === 'weekly' ? 'weekly' : 'five_hour'}`);
  const balanceLabel = t('quota_pool.window_remaining', { window: windowLabel });
  return (
    <article
      className={`${styles.pool} ${styles[pool.provider]}`}
      aria-labelledby={`${id}-title`}
      data-forecast-state={pool.forecastState}
      data-chart-mode={mode}
    >
      <div className={styles.poolHeader}>
        <div className={styles.poolIdentity}>
          <div className={styles.poolTitle}>
            <PoolProviderMark provider={pool.provider} />
            <h2 id={`${id}-title`}>
              {t(`quota_pool.${pool.provider}`)}
              {pool.sourceLabel && <small> · {pool.sourceLabel}</small>}
            </h2>
            <span>{t('quota_pool.account_count', { count: pool.accountCount })}</span>
            <span className={styles.badge} data-state={pool.forecastState}>
              {savedData
                ? t('quota_pool.saved_forecast')
                : pool.forecastState === 'partial' || pool.forecastState === 'stale'
                  ? t('quota_pool.projection_unavailable')
                  : t('quota_pool.forecast_status', {
                      state: t(`quota_pool.state.${pool.forecastState}`),
                    })}
            </span>
            <span className={styles.reorder}>
              <PoolGraphToggle
                minimized={minimized}
                onToggle={() => setMinimized((value) => !value)}
                label={`${t(`quota_pool.${pool.provider}`)}${pool.sourceLabel ? ` · ${pool.sourceLabel}` : ''}`}
                controls={`${id}-plot`}
              />
              {move && (
                <>
                  <button
                    type="button"
                    onClick={move.up}
                    disabled={!move.up}
                    aria-label={t('quota_pool.move_up', { pool: t(`quota_pool.${pool.provider}`) })}
                    title={t('quota_pool.move_up', { pool: t(`quota_pool.${pool.provider}`) })}
                  >
                    <IconChevronUp size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={move.down}
                    disabled={!move.down}
                    aria-label={t('quota_pool.move_down', {
                      pool: t(`quota_pool.${pool.provider}`),
                    })}
                    title={t('quota_pool.move_down', { pool: t(`quota_pool.${pool.provider}`) })}
                  >
                    <IconChevronDown size={18} aria-hidden="true" />
                  </button>
                </>
              )}
            </span>
          </div>
          <div className={styles.headline} data-unavailable={pool[metricField[mode]] === null}>
            <strong>
              {pool[metricField[mode]] === null
                ? t(
                    `quota_pool.${mode === 'remaining' ? 'total_unavailable_title' : 'forecast_unavailable'}`
                  )
                : number(pool[metricField[mode]])}
            </strong>
            <div className={styles.headlineContext}>
              <p className={styles.metricLabel}>
                {mode !== 'remaining'
                  ? t('quota_pool.recorded_rate', {
                      rate: t(`quota_pool.${mode}`),
                      hours: dashboard.lookbackHours,
                    })
                  : balanceLabel}
              </p>
              <span>
                {mode === 'remaining'
                  ? t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })
                  : t('quota_pool.points_hour')}
              </span>
            </div>
          </div>
          {mode !== 'remaining' && (
            <p className={styles.balanceContext}>
              {balanceLabel}: <strong>{number(pool.remainingPoints)}</strong>{' '}
              {t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}
            </p>
          )}
          {savedData && (
            <p className={styles.coverage}>
              {t('quota_pool.saved_snapshot')}: {date(dashboard.nowMs)}
            </p>
          )}
        </div>
        <div className={styles.statsBlock}>
          {mode !== 'remaining' && (
            <p className={styles.statsHeading}>{t('quota_pool.remaining_forecast')}</p>
          )}
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
            {mode !== 'burn' && (
              <div>
                <dt>{t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}</dt>
                <dd>
                  {number(pool.burnPointsPerHour)} {t('quota_pool.points_hour')}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
      {pool.forecastState !== 'ready' && (
        <p className={styles.stateNote} role="status" data-state={pool.forecastState}>
          {t(`quota_pool.state_note.${pool.forecastState}`)}
        </p>
      )}
      <PoolGraph title={t('quota_pool.history_forecast')} id={`${id}-plot`} minimized={minimized}>
        <PoolChart
          key={`${mode}-${dashboard.fromMs}`}
          pool={pool}
          dashboard={dashboard}
          mode={mode}
          savedData={savedData}
          minimized={minimized}
        />
      </PoolGraph>
      <section className={styles.accounts} aria-labelledby={`${id}-accounts`}>
        <h3 id={`${id}-accounts`}>
          <span>
            {t('quota_pool.accounts')} ·{' '}
            {t('quota_pool.coverage', { loaded: pool.loadedCount, eligible: pool.eligibleCount })}
          </span>
          {pool.accounts.length > 0 && (
            <button
              type="button"
              className={styles.expandAccounts}
              aria-expanded={allOpen}
              onClick={() =>
                setOpenAccounts(allOpen ? new Set() : new Set(pool.accounts.map((a) => a.id)))
              }
            >
              {t(allOpen ? 'quota_pool.collapse_accounts' : 'quota_pool.expand_accounts')}
            </button>
          )}
          <span>{t('quota_pool.remaining')}</span>
        </h3>
        <div className={styles.accountGrid}>
          {pool.accounts.length === 0 ? (
            <p className={styles.stateNote}>{t('quota_pool.state_note.no-accounts')}</p>
          ) : (
            pool.accounts.map((account) => (
              <details
                key={account.id}
                className={styles.account}
                data-status={account.status}
                open={openAccounts.has(account.id)}
                onToggle={(event) => setAccountOpen(account.id, event.currentTarget.open)}
              >
                <summary>
                  <span className={styles.accountName}>
                    {reveal && account.email ? account.email : account.label}
                    <small className={styles.accountPlan}>
                      {account.plan.known && account.plan.label
                        ? t('quota_pool.account_plan', {
                            plan: account.plan.label,
                            points: number(account.plan.capacityPoints),
                          })
                        : t('quota_pool.account_plan_unknown', {
                            points: number(account.plan.capacityPoints),
                          })}
                    </small>
                  </span>
                  <span className={styles.accountStatus}>
                    {savedData && account.status === 'ok'
                      ? t('quota_pool.saved_observation')
                      : account.status === 'missing-window'
                        ? t('quota_pool.window_unavailable', { window: windowLabel })
                        : t(`quota_pool.account_status.${account.status}`)}
                    {account.status === 'stale' && (
                      <>
                        {' '}
                        · {t('quota_pool.observed')}: {date(account.observedAtMs)}
                      </>
                    )}
                  </span>
                  <strong>
                    {account.remainingPercent === null
                      ? '—'
                      : `${number(account.remainingPercent)}%`}
                    {account.status === 'stale' && (
                      <small>{t('quota_pool.account_status.stale')}</small>
                    )}
                  </strong>
                  {account.windows.length > 0 && (
                    <ul className={styles.limits} aria-label={t('quota_pool.limits')}>
                      {account.windows.map((limit) => (
                        <li
                          key={limit.id}
                          data-low={limit.remainingPercent !== null && limit.remainingPercent < 20}
                        >
                          <span>{t(limit.labelKey, limit.labelParams)}</span>
                          <span className={styles.limitBar} aria-hidden="true">
                            <span style={{ width: `${limit.remainingPercent ?? 0}%` }} />
                          </span>
                          <strong>
                            {limit.remainingPercent === null
                              ? '—'
                              : `${number(limit.remainingPercent)}%`}
                          </strong>
                          {limit.resetAtMs !== null && (
                            <small>
                              {t('quota_pool.limit_resets', { date: date(limit.resetAtMs) })}
                            </small>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
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
                    <dt>{t('quota_pool.predicted_empty')}</dt>
                    <dd>
                      {forecastDate(
                        account.emptyAtMs,
                        pool.forecastState === 'ready' && account.status === 'ok'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}</dt>
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
