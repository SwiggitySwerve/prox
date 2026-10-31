import { useId, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import { metricField, type ChartMode } from './chartGeometry';
import { PoolChart } from './PoolChart';
import { PoolGraph } from './PoolGraph';
import { PoolGraphToggle } from './PoolGraphToggle';
import { PoolProviderMark } from './PoolProviderMark';
import { formatPoolDate, formatPoolNumber, isLowQuota } from './presentation';
import styles from './QuotaPoolPage.module.scss';

/** Rosters longer than this get a search box and a sort, so one account can be found. */
const ROSTER_CONTROLS_MIN = 8;

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
  const [rosterQuery, setRosterQuery] = useState('');
  const [rosterSort, setRosterSort] = useState<'default' | 'lowest'>('default');
  const [lowOnly, setLowOnly] = useState(false);
  // Opening a row reveals reset details; minimization only compacts closed rows.
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
    value === null ? (
      available ? (
        t('quota_pool.not_predicted')
      ) : (
        <>
          <span aria-hidden="true">—</span>
          <span className={styles.srOnly}>{t('quota_pool.forecast_unavailable')}</span>
        </>
      )
    ) : (
      date(value)
    );
  const windowLabel = t(`quota_pool.${dashboard.window === 'weekly' ? 'weekly' : 'five_hour'}`);
  const balanceLabel = t('quota_pool.window_remaining', { window: windowLabel });
  const showRosterControls = pool.accounts.length > ROSTER_CONTROLS_MIN;
  const accountName = (account: (typeof pool.accounts)[number]) =>
    reveal && account.email ? account.email : (account.identifier ?? account.label);
  const lowestPercent = (account: (typeof pool.accounts)[number]) =>
    Math.min(
      ...account.windows.flatMap((limit) =>
        limit.remainingPercent === null ? [] : [limit.remainingPercent]
      ),
      account.remainingPercent ?? Infinity
    );
  const query = rosterQuery.trim().toLowerCase();
  const matchingAccounts = pool.accounts.filter(
    (account) => !query || accountName(account).toLowerCase().includes(query)
  );
  // Counted within the search, so the chip's number is what the filter will show.
  const lowAccountCount = matchingAccounts.filter((account) =>
    account.windows.some((limit) => isLowQuota(limit.remainingPercent))
  ).length;
  const visibleAccounts = matchingAccounts
    .filter(
      (account) => !lowOnly || account.windows.some((limit) => isLowQuota(limit.remainingPercent))
    )
    .sort((a, b) => (rosterSort === 'lowest' ? lowestPercent(a) - lowestPercent(b) : 0));
  // One column per limit the roster reports, so every account's bars line up under one heading.
  const limitColumns = pool.accounts.reduce<
    Array<(typeof pool.accounts)[number]['windows'][number]>
  >((columns, account) => {
    account.windows.forEach((limit) => {
      if (!columns.some((column) => column.id === limit.id)) columns.push(limit);
    });
    return columns;
  }, []);
  return (
    <article
      className={`${styles.pool} ${styles[pool.provider]}`}
      aria-labelledby={`${id}-title`}
      data-forecast-state={pool.forecastState}
      data-chart-mode={mode}
      data-minimized={minimized}
      data-saved={savedData}
    >
      <div className={styles.poolHeader}>
        <div className={styles.poolIdentity}>
          <div className={styles.poolTitle}>
            <PoolProviderMark provider={pool.provider} />
            <h2 id={`${id}-title`}>
              {t(`quota_pool.${pool.provider}`)}
              {pool.sourceLabel && <small> · {pool.sourceLabel}</small>}
            </h2>
            <div className={styles.poolMeta}>
              <span>{t('quota_pool.account_count', { count: pool.accountCount })}</span>
              <span className={styles.badge} data-state={savedData ? 'saved' : pool.forecastState}>
                {savedData
                  ? t('quota_pool.saved_forecast')
                  : t('quota_pool.forecast_status', {
                      state: t(`quota_pool.state.${pool.forecastState}`),
                    })}
              </span>
            </div>
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
          <div
            className={styles.headline}
            data-unavailable={pool[metricField[mode]] === null}
            data-no-limit={pool.forecastState === 'no-limit'}
          >
            <strong>
              {pool.forecastState === 'no-limit'
                ? t('quota_pool.no_window_limit', { window: windowLabel })
                : pool[metricField[mode]] === null
                  ? t(
                      `quota_pool.${mode === 'remaining' ? 'total_unavailable_title' : 'forecast_unavailable'}`
                    )
                  : number(pool[metricField[mode]])}
              {mode !== 'remaining' && pool[metricField[mode]] !== null && (
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
                  : balanceLabel}
              </p>
              {mode === 'remaining' && (
                <span>
                  {t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}
                </span>
              )}
            </div>
          </div>
          {mode !== 'remaining' && (
            <p className={styles.balanceContext}>
              {balanceLabel}: <strong>{number(pool.remainingPoints)}</strong>{' '}
              {t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}
            </p>
          )}
          {/* Why the forecast or total is limited, under the headline it qualifies. */}
          {pool.forecastState !== 'ready' && (
            <p className={styles.stateNote} role="status" data-state={pool.forecastState}>
              {t(`quota_pool.state_note.${pool.forecastState}`, { window: windowLabel })}
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
            {/* Rate views lead with the rate itself; this group is the remaining-quota forecast. */}
            {mode === 'remaining' && (
              <div>
                <dt>{t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}</dt>
                <dd>
                  {number(pool.burnPointsPerHour)}
                  {pool.burnPointsPerHour !== null && ` ${t('quota_pool.points_hour')}`}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
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
            <b className={styles.accountHeadingLabel}>{t('quota_pool.accounts')}</b>
            <span className={styles.accountBalanceLabel}>
              · {t('quota_pool.account_remaining', { window: windowLabel })}
            </span>
            {/* The card header already counts the accounts; say coverage only when some are missing. */}
            {(pool.loadedCount !== pool.accountCount ||
              pool.eligibleCount !== pool.accountCount) && (
              <small className={styles.accountCoverage}>
                {t('quota_pool.coverage', {
                  loaded: pool.loadedCount,
                  eligible: pool.eligibleCount,
                })}
              </small>
            )}
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
        </h3>
        {showRosterControls && (
          <div className={styles.rosterTools}>
            <input
              type="search"
              className={styles.rosterSearch}
              value={rosterQuery}
              onChange={(event) => setRosterQuery(event.target.value)}
              placeholder={t('quota_pool.account_search')}
              aria-label={t('quota_pool.account_search')}
            />
            <select
              value={rosterSort}
              onChange={(event) => setRosterSort(event.target.value as 'default' | 'lowest')}
              aria-label={t('quota_pool.account_sort')}
            >
              <option value="default">{t('quota_pool.sort_default')}</option>
              <option value="lowest">{t('quota_pool.sort_lowest')}</option>
            </select>
            {(lowAccountCount > 0 || lowOnly) && (
              <button
                type="button"
                className={styles.rosterLow}
                aria-pressed={lowOnly}
                onClick={() => setLowOnly((value) => !value)}
              >
                <IconAlertTriangle size={14} aria-hidden="true" />
                {t('quota_pool.accounts_low', { count: lowAccountCount })}
              </button>
            )}
            <span className={styles.rosterCount} role="status">
              {query || lowOnly
                ? t('quota_pool.accounts_shown', {
                    shown: visibleAccounts.length,
                    total: pool.accounts.length,
                  })
                : null}
            </span>
          </div>
        )}
        <div
          className={styles.accountGrid}
          data-large={showRosterControls}
          style={{ '--limit-cols': Math.max(1, limitColumns.length) } as CSSProperties}
        >
          {visibleAccounts.length > 0 && (
            <div className={styles.accountHead} aria-hidden="true">
              <span />
              <span />
              <span />
              {limitColumns.map((limit) => (
                <span key={limit.id}>{t(limit.labelKey, limit.labelParams)}</span>
              ))}
              <span>{t('quota_pool.account_remaining', { window: windowLabel })}</span>
            </div>
          )}
          {pool.accounts.length === 0 ? (
            <p className={styles.stateNote}>{t('quota_pool.state_note.no-accounts')}</p>
          ) : visibleAccounts.length === 0 ? (
            <p className={styles.stateNote} role="status">
              {t('quota_pool.no_account_matches')}
            </p>
          ) : (
            visibleAccounts.map((account) => (
              <details
                key={account.id}
                className={styles.account}
                data-status={account.status}
                open={openAccounts.has(account.id)}
                onToggle={(event) => setAccountOpen(account.id, event.currentTarget.open)}
              >
                <summary>
                  <IconChevronDown
                    className={styles.accountDisclosure}
                    size={20}
                    aria-hidden="true"
                  />
                  <span className={styles.accountName}>
                    <span className={styles.accountLabel}>{accountName(account)}</span>
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
                    {account.status === 'stale'
                      ? `${t('quota_pool.account_status.stale')} · ${t('quota_pool.observed')}: ${date(account.observedAtMs)}`
                      : account.status === 'no-limit'
                        ? t('quota_pool.no_window_limit', { window: windowLabel })
                        : account.status === 'missing-window' || account.status === 'error'
                          ? t('quota_pool.window_unavailable', { window: windowLabel })
                          : t(`quota_pool.account_status.${account.status}`)}
                  </span>
                  <strong>
                    {account.remainingPercent === null
                      ? '—'
                      : `${number(account.remainingPercent)}%`}
                  </strong>
                  {account.windows.length > 0 && (
                    <ul className={styles.limits} aria-label={t('quota_pool.limits')}>
                      {account.windows.map((limit) => (
                        <li
                          key={limit.id}
                          data-low={isLowQuota(limit.remainingPercent)}
                          style={
                            {
                              '--col':
                                limitColumns.findIndex((column) => column.id === limit.id) + 1,
                            } as CSSProperties
                          }
                        >
                          <span>{t(limit.labelKey, limit.labelParams)}</span>
                          <span className={styles.limitBar} aria-hidden="true">
                            <span style={{ width: `${limit.remainingPercent ?? 0}%` }} />
                          </span>
                          <strong>
                            {isLowQuota(limit.remainingPercent) && (
                              <>
                                <span
                                  className={styles.limitWarning}
                                  title={t('quota_pool.limit_low')}
                                >
                                  <IconAlertTriangle size={14} aria-hidden="true" />
                                </span>
                                <span className={styles.srOnly}>{t('quota_pool.limit_low')}</span>
                              </>
                            )}
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
                      {/* Wide screens keep one column per limit, so a limit this account lacks is a visible gap. */}
                      {limitColumns
                        .filter(
                          (column) => !account.windows.some((limit) => limit.id === column.id)
                        )
                        .map((column) => (
                          <li
                            key={`missing-${column.id}`}
                            data-missing="true"
                            data-low="false"
                            style={
                              {
                                '--col':
                                  limitColumns.findIndex((other) => other.id === column.id) + 1,
                              } as CSSProperties
                            }
                          >
                            <span>{t(column.labelKey, column.labelParams)}</span>
                            {/* The reason fills the cell, so the column still says why it is empty. */}
                            <em>
                              {account.noFiveHourLimit && column.id === 'five-hour'
                                ? t('quota_pool.no_window_limit', {
                                    window: t('quota_pool.five_hour'),
                                  })
                                : t('quota_pool.not_reported')}
                            </em>
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
                  {/* A limit row already says when this reset happens; say it once. */}
                  {!account.windows.some((limit) => limit.resetAtMs === account.resetAtMs) && (
                    <div>
                      <dt>{t('quota_pool.account_reset', { window: windowLabel })}</dt>
                      <dd>{date(account.resetAtMs)}</dd>
                    </div>
                  )}
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
                      {number(account.burnPointsPerHour)}
                      {account.burnPointsPerHour !== null && ` ${t('quota_pool.points_hour')}`}
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
