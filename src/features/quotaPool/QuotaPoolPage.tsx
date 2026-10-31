import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconEye,
  IconRefreshCw,
  IconChevronDown,
  IconChevronLeft,
  IconFilterAll,
} from '@/components/ui/icons';
import type { PoolProviderId } from '@/domain/quotaPool/types';
import type { PoolQuery } from '@/services/api/quotaPool';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh, useReportHeaderRefreshBusy } from '@/hooks/useHeaderRefresh';
import { usePoolDashboard } from './usePoolDashboard';
import { PoolCard } from './PoolCard';
import { CombinedPoolCard } from './CombinedPoolCard';
import { movePool, orderPools, poolKey, usePoolOrder } from './poolOrder';
import { PoolProviderMark } from './PoolProviderMark';
import { viewRange, type ChartMode } from './chartGeometry';
import { formatPoolDate, formatPoolNumber } from './presentation';
import styles from './QuotaPoolPage.module.scss';

/** Points per plan (server/quota/plans.ts), listed in About so each weight reads on its own line. */
const PLAN_WEIGHTS = [
  ['Claude Pro · ChatGPT Plus', 100],
  ['Claude Max', 500],
  ['ChatGPT Pro', 1000],
  ['Claude Ultra', 2000],
  ['ChatGPT Pro 500', 2500],
] as const;

export function QuotaPoolPage() {
  const { t, i18n } = useTranslation();
  const [provider, setProvider] = useState<PoolProviderId | 'all'>('all');
  const [mode, setMode] = useState<ChartMode>('remaining');
  const [query, setQuery] = useState<PoolQuery>({
    window: 'weekly',
    lookback: 3,
    multiplier: 1,
    offsetDays: 0,
    reveal: false,
  });
  const state = usePoolDashboard(query);
  const { data, refresh } = state;
  const refreshStatus = state.refreshStatus ?? data;
  const refreshing = state.refreshing || refreshStatus?.refreshing;
  const chartUnavailable = !data?.pools.length;
  const { order, setOrder } = usePoolOrder();
  const orderedPools = data ? orderPools(data.pools, order) : [];
  const shownPools = orderedPools.filter(
    (pool) => provider === 'all' || provider === pool.provider
  );
  const refreshFromHeader = useCallback(async () => {
    if (!(await refresh())) throw new Error(t('quota_pool.refresh_error'));
  }, [refresh, t]);
  useHeaderRefresh(refreshFromHeader, state.connected);
  useReportHeaderRefreshBusy(Boolean(refreshing) || (!data && state.loading));
  const date = (value: number | null, short = false) => formatPoolDate(value, i18n.language, short);
  // The span the charts show, which the 5-hour and rate views narrow.
  const range = data ? viewRange(data, mode) : null;
  const change = <K extends keyof PoolQuery>(key: K, value: PoolQuery[K]) =>
    setQuery((current) => ({ ...current, [key]: value }));

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleRow}>
          <h1>{t('quota_pool.title')}</h1>
          <Link to="/quota/accounts" className={styles.accountLink}>
            {t('quota_pool.accounts')} <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className={styles.actions}>
          {!chartUnavailable && (
            <label className={styles.privacy}>
              <input
                type="checkbox"
                checked={query.reveal}
                onChange={(event) => change('reveal', event.target.checked)}
              />
              <IconEye size={18} aria-hidden="true" />
              {t('quota_pool.show_emails')}
            </label>
          )}
          {/* Manual refresh is the header's refresh button; this shows when the next automatic one runs. */}
          {Boolean(data?.pools.length) && (
            <RefreshCountdown
              dueAtMs={state.nextCollectAtMs}
              refreshing={Boolean(refreshing)}
              retrying={Boolean(state.refreshError)}
            />
          )}
        </div>
      </header>
      {!chartUnavailable && (
        <>
          <div className={styles.providerBar} role="group" aria-label={t('quota_pool.providers')}>
            {(['all', 'claude', 'codex'] as const).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={provider === item}
                onClick={() => setProvider(item)}
                className={item === 'all' ? undefined : styles[item]}
              >
                {item !== 'all' && <PoolProviderMark provider={item} />}
                {item === 'all' && <IconFilterAll size={18} aria-hidden="true" />}
                {t(`quota_pool.${item}`)}
                {item !== 'all' && data && (
                  <span className={styles.count}>
                    {data.pools.find((pool) => pool.provider === item)?.accountCount ?? 0}
                  </span>
                )}
              </button>
            ))}
          </div>
          <fieldset className={styles.toolbar} aria-label={t('quota_pool.chart_mode')}>
            <div className={styles.segment} role="group" aria-label={t('quota_pool.window')}>
              {(['weekly', 'five-hour'] as const).map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={query.window === item}
                  onClick={() => change('window', item)}
                >
                  {t(`quota_pool.${item === 'weekly' ? 'weekly' : 'five_hour'}`)}
                </button>
              ))}
            </div>
            <div className={styles.segment} role="group" aria-label={t('quota_pool.chart_mode')}>
              {(['remaining', 'drain', 'burn'] as const).map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={mode === item}
                  onClick={() => setMode(item)}
                >
                  {t(`quota_pool.${item}`)}
                </button>
              ))}
            </div>
            <div className={styles.chartSettings}>
              {/* The setting's name sits inside the box, so every toolbar control shares one top edge. */}
              <label className={styles.selectLabel}>
                <span className={styles.srOnly}>{t('quota_pool.rate_interval')}</span>
                <span className={styles.selectPrefix} aria-hidden="true">
                  {t('quota_pool.rate_prefix')}
                </span>
                <select
                  value={query.lookback}
                  onChange={(event) =>
                    change('lookback', Number(event.target.value) as PoolQuery['lookback'])
                  }
                >
                  {([1, 3, 6] as const).map((hours) => (
                    <option key={hours} value={hours}>
                      {t('quota_pool.hours', { hours })}
                    </option>
                  ))}
                </select>
              </label>
              {/* Outside the Remaining view the scenario changes nothing, so the box shows why
                  in place of the value; the disabled select keeps the name and the setting. */}
              <label
                className={styles.selectLabel}
                data-disabled={mode !== 'remaining' || undefined}
              >
                <span className={styles.srOnly}>{t('quota_pool.future_usage')}</span>
                <span className={styles.selectPrefix} aria-hidden="true">
                  {t('quota_pool.future_prefix')}
                </span>
                <select
                  value={query.multiplier}
                  disabled={mode !== 'remaining'}
                  aria-describedby={mode !== 'remaining' ? 'pool-recorded-only' : undefined}
                  onChange={(event) =>
                    change('multiplier', Number(event.target.value) as PoolQuery['multiplier'])
                  }
                >
                  {([1, 0.5, 2, 0] as const).map((value) => (
                    <option value={value} key={value}>
                      {t(
                        `quota_pool.scenario.${value === 1 ? 'same' : value === 0.5 ? 'half' : value === 2 ? 'double' : 'idle'}`
                      )}
                    </option>
                  ))}
                </select>
                {mode !== 'remaining' && (
                  <small id="pool-recorded-only" className={styles.selectHint}>
                    {t('quota_pool.recorded_only_short')}
                  </small>
                )}
              </label>
            </div>
            <div className={styles.dateNavigation}>
              <span>
                {range ? `${date(range.fromMs, true)} – ${date(range.toMs, true)}` : null}
              </span>
              <button
                type="button"
                aria-label={t('quota_pool.previous')}
                disabled={query.offsetDays <= -14}
                onClick={() => change('offsetDays', query.offsetDays - 1)}
              >
                <IconChevronLeft size={18} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => change('offsetDays', 0)}>
                {t('quota_pool.today')}
              </button>
              <button
                type="button"
                aria-label={t('quota_pool.next')}
                disabled={query.offsetDays >= 14}
                onClick={() => change('offsetDays', query.offsetDays + 1)}
              >
                <IconChevronLeft size={18} className={styles.nextIcon} aria-hidden="true" />
              </button>
            </div>
          </fieldset>
        </>
      )}
      {!state.connected && (
        <div className={styles.notice} role="status">
          {t('quota_pool.disconnected')}
        </div>
      )}
      {(state.error || state.refreshError) && (
        <div className={`${styles.notice} ${styles.errorNotice}`} role="alert">
          <IconAlertTriangle size={20} className={styles.errorIcon} aria-hidden="true" />
          <div>
            <h2>{t(`quota_pool.${data ? 'refresh_failed_title' : 'load_failed_title'}`)}</h2>
            <p>
              {/* A failed refresh says how old the data still on screen is. */}
              {state.refreshError && data
                ? t('quota_pool.refresh_error_dated', { date: date(data.nowMs) })
                : t(
                    `quota_pool.${state.refreshError ? 'refresh_error' : data ? 'load_error' : 'load_error_initial'}`
                  )}
            </p>
            <p className={styles.errorCause}>
              {(state.refreshError ? state.refreshErrorStatus : state.errorStatus) === null
                ? t('quota_pool.error_network')
                : t('quota_pool.error_status', {
                    status: state.refreshError ? state.refreshErrorStatus : state.errorStatus,
                  })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void (state.refreshError ? state.refresh() : state.reload())}
          >
            {t('quota_pool.retry')}
          </button>
        </div>
      )}
      {data?.issues.map((issue) => (
        <div
          className={styles.notice}
          role="status"
          key={`${issue.instanceId ?? 'legacy'}-${issue.provider}-${issue.code}`}
        >
          {issue.sourceLabel && `${issue.sourceLabel} · `}
          {t(`quota_pool.${issue.provider}`)}: {t(`quota_pool.issue.${issue.code}`)}
        </div>
      ))}
      {data?.combinations?.map((combination) => (
        <p className={styles.notice} role="status" key={combination.provider}>
          {t('provider_sources.separate_pools', {
            provider: t(`quota_pool.${combination.provider}`),
          })}
        </p>
      ))}
      {Boolean(data?.unresolvedHistoryAccountCount) && (
        <p className={styles.notice} role="status">
          {t('provider_sources.unresolved_history')}
        </p>
      )}
      {!data && state.loading && state.connected && (
        <>
          {/* Placeholders shaped like the toolbar that will render: pool tabs, two view
              toggles, the two settings boxes and the date navigator, all on one top edge. */}
          <div className={styles.loadingControls} aria-hidden="true">
            <div className={styles.loadingRow}>
              {[104, 92, 92].map((width, index) => (
                <Skeleton key={index} width={width} height={40} rounded={999} />
              ))}
            </div>
            <div className={styles.loadingRow}>
              <Skeleton className={styles.loadingSegment} height={44} rounded={999} />
              <Skeleton className={styles.loadingSegmentWide} height={44} rounded={999} />
              <span className={styles.loadingSelects}>
                {[100, 184].map((width, index) => (
                  <Skeleton key={index} width={width} height={46} rounded={999} />
                ))}
              </span>
              <Skeleton className={styles.loadingDate} height={40} rounded={10} />
            </div>
          </div>
          <div className={styles.loading} aria-busy="true">
            <div className={styles.loadingHead}>
              <h2>{t('quota_pool.combined_usage')}</h2>
              <span className={styles.loadingStatus} role="status">
                <span className={styles.loadingDot} />
                {t('quota_pool.loading')}
              </span>
            </div>
            {/* The combined card has a headline and a view select, not the provider facts. */}
            <div className={styles.loadingHero}>
              <span className={styles.loadingNumber}>
                <Skeleton width={150} height={44} rounded={8} />
                <span>
                  <Skeleton width={150} height={12} rounded={4} />
                  <Skeleton width={96} height={12} rounded={4} />
                </span>
              </span>
              <Skeleton width={150} height={36} rounded={10} />
            </div>
            <Skeleton height={168} rounded={8} />
          </div>
          {/* One placeholder per provider card, in the card's own order: headline and facts,
              chart, then the first account rows. */}
          {(['claude', 'codex'] as const).map((item) => (
            <div key={item} className={styles.loading} aria-hidden="true">
              <h2 className={styles.loadingTitle}>
                <PoolProviderMark provider={item} />
                {t(`quota_pool.${item}`)}
              </h2>
              <div className={styles.loadingStats}>
                <span className={styles.loadingNumber}>
                  <Skeleton width={130} height={44} rounded={8} />
                  <span>
                    <Skeleton width={150} height={12} rounded={4} />
                    <Skeleton width={96} height={12} rounded={4} />
                  </span>
                </span>
                {[0, 1, 2, 3].map((index) => (
                  <span key={index} className={styles.loadingFact}>
                    <Skeleton width={84} height={10} rounded={4} />
                    <Skeleton width={128} height={16} rounded={4} />
                  </span>
                ))}
              </div>
              <Skeleton height={120} rounded={8} />
              <div className={styles.loadingRows}>
                {[0, 1].map((index) => (
                  <Skeleton key={index} height={36} rounded={8} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {data && shownPools.length > 0 && (
        <CombinedPoolCard
          pools={shownPools}
          dashboard={data}
          provider={provider}
          mode={mode}
          savedData={state.error || state.refreshError}
          reveal={query.reveal}
          onRefresh={() => void refresh()}
        />
      )}
      <div className={styles.pools} aria-busy={state.loading}>
        {data &&
          shownPools.map((pool, index, shown) => (
            <PoolCard
              key={poolKey(pool)}
              pool={pool}
              dashboard={data}
              mode={mode}
              reveal={query.reveal}
              savedData={state.error || state.refreshError}
              move={
                provider === 'all' && shown.length > 1
                  ? {
                      up:
                        index > 0 ? () => setOrder(movePool(shown, poolKey(pool), -1)) : undefined,
                      down:
                        index < shown.length - 1
                          ? () => setOrder(movePool(shown, poolKey(pool), 1))
                          : undefined,
                    }
                  : undefined
              }
            />
          ))}
        {data && data.pools.length === 0 && (
          <div className={`${styles.notice} ${styles.emptyNotice}`}>
            <h2>{t('quota_pool.no_accounts_title')}</h2>
            <p>{t('quota_pool.no_accounts_help')}</p>
            <Link to="/oauth" className={styles.accountLink}>
              {t('quota_pool.add_credentials')} <span aria-hidden="true">→</span>
            </Link>
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        {data && data.pools.length > 0 && (
          <>
            <h2 className={styles.footerLabel}>{t('quota_pool.data_collection')}</h2>
            <dl className={styles.footerFacts}>
              <div>
                <dt>{t('quota_pool.history_since')}</dt>
                <dd>{date(data.historyStartedAtMs)}</dd>
              </div>
              <div>
                <dt>{t('quota_pool.last_refresh')}</dt>
                <dd>{date(refreshStatus?.lastRefreshAtMs ?? null)}</dd>
              </div>
            </dl>
            <details className={styles.about}>
              <summary>
                <IconChevronDown size={16} aria-hidden="true" />
                {t('quota_pool.about_numbers')}
              </summary>
              <ul>
                <li>
                  {t('quota_pool.normalized_intro')}
                  <dl className={styles.planWeights}>
                    {PLAN_WEIGHTS.map(([plan, points]) => (
                      <div key={plan}>
                        <dt>{plan}</dt>
                        <dd>
                          {formatPoolNumber(points, i18n.language)} {t('quota_pool.points')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
                <li>{t('quota_pool.stacked_description')}</li>
                <li>{t('quota_pool.rates_note')}</li>
                <li>{t('quota_pool.limit_note')}</li>
                <li>{t('quota_pool.polling')}</li>
              </ul>
            </details>
          </>
        )}
      </footer>
    </div>
  );
}

/** Seconds until the page's next automatic collection, ticking once a second. */
function RefreshCountdown({
  dueAtMs,
  refreshing,
  retrying,
}: {
  dueAtMs: number | null;
  refreshing: boolean;
  /** After a failed refresh the next automatic one is a retry, and says so. */
  retrying: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (dueAtMs === null) return null;
  return (
    <span className={styles.countdown} data-refreshing={refreshing} role="status">
      <IconRefreshCw size={16} aria-hidden="true" />
      {refreshing
        ? t('quota_pool.refreshing')
        : t(`quota_pool.${retrying ? 'auto_retry_in' : 'auto_refresh_in'}`, {
            seconds: Math.max(0, Math.ceil((dueAtMs - now) / 1000)),
          })}
    </span>
  );
}
