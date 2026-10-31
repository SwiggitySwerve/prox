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
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePoolDashboard } from './usePoolDashboard';
import { PoolCard } from './PoolCard';
import { CombinedPoolCard } from './CombinedPoolCard';
import { movePool, orderPools, poolKey, usePoolOrder } from './poolOrder';
import { PoolProviderMark } from './PoolProviderMark';
import type { ChartMode } from './chartGeometry';
import { formatPoolDate } from './presentation';
import styles from './QuotaPoolPage.module.scss';

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
  const date = (value: number | null, short = false) => formatPoolDate(value, i18n.language, short);
  const change = <K extends keyof PoolQuery>(key: K, value: PoolQuery[K]) =>
    setQuery((current) => ({ ...current, [key]: value }));

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleRow}>
          <h1>{t('quota_pool.title')}</h1>
          <Link to="/quota/accounts" className={styles.accountLink}>
            {t('quota_pool.accounts')} <span aria-hidden="true">↗</span>
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
            <RefreshCountdown dueAtMs={state.nextCollectAtMs} refreshing={Boolean(refreshing)} />
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
              <label className={styles.selectLabel}>
                {t('quota_pool.rate_interval')}
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
              <label className={styles.selectLabel}>
                {t('quota_pool.future_usage')}
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
              </label>
            </div>
            <div className={styles.dateNavigation}>
              <span>{data ? `${date(data.fromMs, true)} – ${date(data.toMs, true)}` : null}</span>
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
            {/* The reason Future usage is disabled sits with the controls it explains. */}
            {mode !== 'remaining' && (
              <p id="pool-recorded-only" className={styles.stateNote}>
                {t('quota_pool.recorded_only')}
              </p>
            )}
          </fieldset>
        </>
      )}
      {!chartUnavailable && <p className={styles.method}>{t('quota_pool.normalized_short')}</p>}
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
              {t(
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
          {/* Placeholders where the provider filter and chart controls will render. */}
          <div className={styles.loadingControls} aria-hidden="true">
            {[
              [112, 84, 84],
              [168, 250, 84, 120],
            ].map((row, line) => (
              <div key={line}>
                {row.map((width, index) => (
                  <Skeleton key={index} width={width} height={40} rounded={999} />
                ))}
              </div>
            ))}
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
              <Skeleton width={200} height={48} rounded={8} />
              <Skeleton width={150} height={36} rounded={999} />
            </div>
            <Skeleton height={168} rounded={8} />
          </div>
          {/* One placeholder per provider card that will follow. */}
          {(['claude', 'codex'] as const).map((item) => (
            <div key={item} className={styles.loading} aria-hidden="true">
              <h2 className={styles.loadingTitle}>
                <PoolProviderMark provider={item} />
                {t(`quota_pool.${item}`)}
              </h2>
              <div className={styles.loadingStats}>
                <Skeleton height={56} rounded={6} />
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} height={36} rounded={6} />
                ))}
              </div>
              <Skeleton height={120} rounded={8} />
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
          <div className={styles.notice}>
            <h2>{t('quota_pool.no_accounts_title')}</h2>
            <p>{t('quota_pool.no_accounts_help')}</p>
            <Link to="/oauth" className={styles.accountLink}>
              {t('quota_pool.add_credentials')}
            </Link>
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        {data && data.pools.length > 0 && (
          <>
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
                <li>{t('quota_pool.normalized')}</li>
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
}: {
  dueAtMs: number | null;
  refreshing: boolean;
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
        : t('quota_pool.auto_refresh_in', {
            seconds: Math.max(0, Math.ceil((dueAtMs - now) / 1000)),
          })}
    </span>
  );
}
