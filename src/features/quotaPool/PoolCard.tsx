import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconCircleHalf,
  IconClock,
  IconHistory,
  IconInfo,
  IconTimer,
} from '@/components/ui/icons';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import { metricField, type ChartMode } from './chartGeometry';
import { DAY_MS } from '@/utils/time/durations';
import { PoolChart } from './PoolChart';
import { PoolGraph } from './PoolGraph';
import { PoolGraphToggle } from './PoolGraphToggle';
import { PoolProviderMark } from './PoolProviderMark';
import { poolChip, type PoolChipIcon } from './model/poolChip';
import { sortAccounts, type AccountSort } from './model/accountOrder';
import { formatPoolDate, formatPoolNumber, formatPoolPercent, isLowQuota } from './presentation';
import styles from './QuotaPoolPage.module.scss';

/** Rosters longer than this get a search box and a sort, so one account can be found. */
const ROSTER_CONTROLS_MIN = 8;
/** Rows shown before "Show all", so a long roster doesn't bury the next pool. */
const ROSTER_PAGE = 25;
const CHIP_ICONS: Record<PoolChipIcon, typeof IconCheck> = {
  check: IconCheck,
  partial: IconCircleHalf,
  stale: IconClock,
  saved: IconHistory,
  collecting: IconTimer,
  info: IconInfo,
};

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
  const [rosterSort, setRosterSort] = useState<AccountSort>('name');
  const [lowOnly, setLowOnly] = useState(false);
  const [affectedOnly, setAffectedOnly] = useState(false);
  // Bumped by the notice's action; the effect then brings the first affected row into focus.
  const [affectedFocus, setAffectedFocus] = useState(0);
  const accountsRef = useRef<HTMLElement>(null);
  const [showAll, setShowAll] = useState(false);
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
  const percent = (value: number) => formatPoolPercent(value, i18n.language);
  const date = (value: number | null) => formatPoolDate(value, i18n.language);
  const forecastDate = (value: number | null, available = pool.forecastState === 'ready') =>
    value === null ? (
      available ? (
        // Not reached before the server's forecast horizon (server/quota/domain.ts projects to
        // the later of the range end and 14 days out), whatever the chart shows.
        t('quota_pool.after_range', {
          date: formatPoolDate(
            Math.max(dashboard.toMs, dashboard.nowMs + 14 * DAY_MS),
            i18n.language,
            true
          ),
        })
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
  const missingAccounts = pool.accounts.filter(
    (account) => account.status === 'error' || account.status === 'missing-window'
  );
  const staleAccounts = pool.accounts.filter((account) => account.status === 'stale');
  // The accounts holding the total back. The notice counts them and its action shows them in
  // the list, instead of naming masked addresses that wrap badly.
  const affectedAccounts =
    pool.forecastState === 'partial'
      ? missingAccounts
      : pool.forecastState === 'stale'
        ? staleAccounts
        : [];
  const affectedIds = new Set(affectedAccounts.map((account) => account.id));
  const stateNote =
    pool.forecastState === 'partial' && missingAccounts.length
      ? t('quota_pool.unavailable_count', {
          count: missingAccounts.length,
          total: pool.accountCount,
        })
      : pool.forecastState === 'stale' && staleAccounts.length
        ? t('quota_pool.stale_count', { count: staleAccounts.length, total: pool.accountCount })
        : t(`quota_pool.state_note.${pool.forecastState}`, { window: windowLabel });
  const showAffected = () => {
    setAffectedOnly(true);
    setLowOnly(false);
    setRosterQuery('');
    setShowAll(false);
    setAffectedFocus((value) => value + 1);
  };
  useEffect(() => {
    if (!affectedFocus) return;
    accountsRef.current?.scrollIntoView({ block: 'start' });
    accountsRef.current?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  }, [affectedFocus]);
  const forecastWithheld = pool.forecastState !== 'ready' && pool.forecastState !== 'no-limit';
  // Claude names its weekly windows "7-day"; the page calls that window Weekly everywhere.
  const limitLabel = (limit: (typeof pool.accounts)[number]['windows'][number]) =>
    limit.id === 'seven-day'
      ? t('quota_pool.weekly_limit')
      : limit.id === 'seven-day-opus'
        ? t('quota_pool.weekly_opus')
        : t(limit.labelKey, limit.labelParams);
  const query = rosterQuery.trim().toLowerCase();
  const matchingAccounts = pool.accounts.filter(
    (account) => !query || accountName(account).toLowerCase().includes(query)
  );
  // Counted within the search, so the chip's number is what the filter will show.
  const lowAccountCount = matchingAccounts.filter((account) =>
    account.windows.some((limit) => isLowQuota(limit.remainingPercent))
  ).length;
  const visibleAccounts = sortAccounts(
    matchingAccounts.filter(
      (account) =>
        (!lowOnly || account.windows.some((limit) => isLowQuota(limit.remainingPercent))) &&
        (!affectedOnly || affectedIds.has(account.id))
    ),
    rosterSort,
    accountName,
    i18n.language
  );
  // One column per limit the roster reports, so every account's bars line up under one heading.
  const limitColumns = pool.accounts.reduce<
    Array<(typeof pool.accounts)[number]['windows'][number]>
  >((columns, account) => {
    account.windows.forEach((limit) => {
      if (!columns.some((column) => column.id === limit.id)) columns.push(limit);
    });
    return columns;
  }, []);
  // The pool balance is the sample of one limit (server/quota/collector.ts): the 5-hour
  // limit, or the provider's weekly one. Mark that column instead of repeating it.
  const countedLimitId =
    dashboard.window === 'five-hour'
      ? 'five-hour'
      : pool.provider === 'claude'
        ? 'seven-day'
        : 'weekly';
  const balanceHasColumn = limitColumns.some((column) => column.id === countedLimitId);
  const pageAccounts = showAll ? visibleAccounts : visibleAccounts.slice(0, ROSTER_PAGE);
  const noLimitCount =
    dashboard.window === 'five-hour'
      ? pool.accounts.filter((account) => account.noFiveHourLimit).length
      : 0;
  const chip = poolChip(pool.forecastState, savedData);
  const ChipIcon = CHIP_ICONS[chip.icon];
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
              <span
                className={styles.badge}
                data-state={chip.state}
                data-chip-icon={chip.icon}
                data-tone={chip.tone}
              >
                <ChipIcon size={13} aria-hidden="true" />
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
                    <IconArrowUp size={16} aria-hidden="true" />
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
                    <IconArrowDown size={16} aria-hidden="true" />
                  </button>
                </>
              )}
            </span>
          </div>
          <div
            className={styles.headline}
            data-unavailable={pool[metricField[mode]] === null}
            data-rate={mode !== 'remaining'}
            data-no-limit={pool.forecastState === 'no-limit'}
          >
            <strong>
              {pool.forecastState === 'no-limit' ? (
                t('quota_pool.no_window_limit', { window: windowLabel })
              ) : pool[metricField[mode]] === null ? (
                // The value slot says the total is missing; the label still names the metric.
                <span className={styles.unavailableValue}>{t('quota_pool.value_unavailable')}</span>
              ) : (
                number(pool[metricField[mode]])
              )}
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
        </div>
        <div className={styles.statsBlock}>
          {mode !== 'remaining' && (
            <p className={styles.statsHeading}>{t('quota_pool.remaining_forecast')}</p>
          )}
          <dl className={styles.stats}>
            {mode !== 'remaining' && (
              <div>
                <dt>{t('quota_pool.account_remaining', { window: windowLabel })}</dt>
                <dd>
                  {number(pool.remainingPoints)}{' '}
                  <small>
                    {t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}
                  </small>
                </dd>
              </div>
            )}
            {/* A withheld forecast is explained by the notice; its empty facts aren't repeated. */}
            {!(forecastWithheld && pool.poolEmptyAtMs === null) && (
              <div>
                <dt>{t('quota_pool.pool_empty')}</dt>
                <dd>{forecastDate(pool.poolEmptyAtMs)}</dd>
              </div>
            )}
            {!(forecastWithheld && pool.firstEmptyAtMs === null) && (
              <div>
                <dt>{t('quota_pool.first_empty')}</dt>
                <dd>{forecastDate(pool.firstEmptyAtMs)}</dd>
              </div>
            )}
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
            {mode === 'remaining' && !(forecastWithheld && pool.burnPointsPerHour === null) && (
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
      {/* Why the forecast or total is limited, across the card under its summary. */}
      {pool.forecastState !== 'ready' && (
        <p className={styles.stateNote} role="status" data-state={pool.forecastState}>
          {/* The page's one "Refresh now" sits in the combined card's notice above. */}
          <span>{stateNote}</span>
          {affectedAccounts.length > 0 && (
            <button type="button" className={styles.noteAction} onClick={showAffected}>
              {t('quota_pool.show_affected')}
            </button>
          )}
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
      <section ref={accountsRef} className={styles.accounts} aria-labelledby={`${id}-accounts`}>
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
                {/* In the 5-hour view an account without that limit is excluded, not missing. */}
                {staleAccounts.length > 0
                  ? t('quota_pool.coverage_stale', {
                      current: pool.loadedCount,
                      stale: staleAccounts.length,
                    })
                  : noLimitCount > 0
                    ? [
                        t('quota_pool.coverage_with_limit', {
                          eligible: pool.eligibleCount,
                          total: pool.accountCount,
                        }),
                        ...(pool.loadedCount < pool.eligibleCount
                          ? [
                              t('quota_pool.coverage', {
                                loaded: pool.loadedCount,
                                eligible: pool.eligibleCount,
                              }),
                            ]
                          : []),
                      ].join(' · ')
                    : t('quota_pool.coverage', {
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
        {(showRosterControls || affectedOnly) && (
          <div className={styles.rosterTools}>
            {showRosterControls && (
              <>
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
                  onChange={(event) => setRosterSort(event.target.value as AccountSort)}
                  aria-label={t('quota_pool.account_sort')}
                >
                  <option value="name">{t('quota_pool.sort_name')}</option>
                  <option value="lowest">{t('quota_pool.sort_lowest')}</option>
                </select>
              </>
            )}
            {(affectedOnly || (showRosterControls && affectedAccounts.length > 0)) && (
              <button
                type="button"
                className={styles.rosterLow}
                aria-pressed={affectedOnly}
                onClick={() => {
                  setAffectedOnly((value) => !value);
                  setLowOnly(false);
                }}
              >
                {affectedOnly ? (
                  <IconCheck size={14} aria-hidden="true" />
                ) : (
                  <IconAlertTriangle size={14} aria-hidden="true" />
                )}
                {t('quota_pool.accounts_affected', { count: affectedAccounts.length })}
              </button>
            )}
            {showRosterControls && (lowAccountCount > 0 || lowOnly) && (
              <button
                type="button"
                className={styles.rosterLow}
                aria-pressed={lowOnly}
                onClick={() => {
                  setLowOnly((value) => !value);
                  setAffectedOnly(false);
                }}
              >
                {lowOnly ? (
                  <IconCheck size={14} aria-hidden="true" />
                ) : (
                  <IconAlertTriangle size={14} aria-hidden="true" />
                )}
                {t('quota_pool.accounts_low', { count: lowAccountCount })}
              </button>
            )}
            <span className={styles.rosterCount} role="status">
              {query || lowOnly || affectedOnly || pageAccounts.length < visibleAccounts.length
                ? t('quota_pool.accounts_shown', {
                    shown: pageAccounts.length,
                    // Paging counts against the filtered list; filtering counts against the whole roster.
                    total:
                      pageAccounts.length < visibleAccounts.length
                        ? visibleAccounts.length
                        : pool.accounts.length,
                  })
                : null}
            </span>
          </div>
        )}
        <div
          className={styles.accountGrid}
          data-large={showRosterControls}
          data-balance-column={!balanceHasColumn}
          style={{ '--limit-cols': Math.max(1, limitColumns.length) } as CSSProperties}
        >
          {visibleAccounts.length > 0 && (
            <div className={styles.accountHead} aria-hidden="true">
              <span />
              <span />
              <span />
              {limitColumns.map((limit) => (
                <span key={limit.id} data-counted={limit.id === countedLimitId || undefined}>
                  {limitLabel(limit)}
                  {limit.id === countedLimitId && (
                    <small>{t('quota_pool.counts_toward_total')}</small>
                  )}
                </span>
              ))}
              {!balanceHasColumn && (
                <span>{t('quota_pool.account_remaining', { window: windowLabel })}</span>
              )}
            </div>
          )}
          {pool.accounts.length === 0 ? (
            <p className={styles.stateNote}>{t('quota_pool.state_note.no-accounts')}</p>
          ) : visibleAccounts.length === 0 ? (
            <p className={styles.stateNote} role="status">
              {t('quota_pool.no_account_matches')}
            </p>
          ) : (
            pageAccounts.map((account) => (
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
                      ? `${t('quota_pool.account_status.stale')} · ${t('quota_pool.observed')} ${date(account.observedAtMs)}`
                      : account.status === 'no-limit'
                        ? t('quota_pool.no_window_limit', { window: windowLabel })
                        : account.status === 'missing-window' || account.status === 'error'
                          ? t('quota_pool.window_unavailable', { window: windowLabel })
                          : t(`quota_pool.account_status.${account.status}`)}
                  </span>
                  <strong data-low={isLowQuota(account.remainingPercent) || undefined}>
                    {isLowQuota(account.remainingPercent) && (
                      <>
                        <IconAlertTriangle size={14} aria-hidden="true" />
                        <span className={styles.srOnly}>{t('quota_pool.limit_low')}</span>
                      </>
                    )}
                    {/* An account without this limit says so in the value slot, once. */}
                    {account.status === 'no-limit' ? (
                      <span className={styles.noLimitValue}>
                        {t('quota_pool.no_window_limit', { window: windowLabel })}
                      </span>
                    ) : account.remainingPercent === null ? (
                      '—'
                    ) : (
                      percent(account.remainingPercent)
                    )}
                  </strong>
                  {account.windows.length > 0 && (
                    <ul className={styles.limits} aria-label={t('quota_pool.limits')}>
                      {account.windows.map((limit) => (
                        <li
                          key={limit.id}
                          data-low={isLowQuota(limit.remainingPercent)}
                          data-counted={limit.id === countedLimitId || undefined}
                          style={
                            {
                              '--col':
                                limitColumns.findIndex((column) => column.id === limit.id) + 1,
                            } as CSSProperties
                          }
                        >
                          <span>{limitLabel(limit)}</span>
                          {/* No track for a missing value, so it can't read as 0%. */}
                          {limit.remainingPercent !== null && (
                            <span className={styles.limitBar} aria-hidden="true">
                              <span style={{ width: `${limit.remainingPercent}%` }} />
                            </span>
                          )}
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
                              : percent(limit.remainingPercent)}
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
                            <span>{limitLabel(column)}</span>
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
        {pageAccounts.length < visibleAccounts.length && (
          <button
            type="button"
            className={`${styles.expandAccounts} ${styles.showAll}`}
            onClick={() => setShowAll(true)}
          >
            {t('quota_pool.show_more_accounts', {
              count: visibleAccounts.length - pageAccounts.length,
            })}
          </button>
        )}
      </section>
    </article>
  );
}
