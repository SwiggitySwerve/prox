import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconEye, IconRefreshCw, IconChevronLeft, IconFilterAll } from '@/components/ui/icons';
import type { PoolProviderId } from '@/domain/quotaPool/types';
import type { PoolQuery } from '@/services/api/quotaPool';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePoolDashboard } from './usePoolDashboard';
import { PoolCard } from './PoolCard';
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
  const initialLoading = state.loading && !data;
  const chartUnavailable = !data?.pools.length;
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
          <label className={styles.privacy}>
            <input
              type="checkbox"
              checked={query.reveal}
              disabled={chartUnavailable}
              onChange={(event) => change('reveal', event.target.checked)}
            />
            <IconEye size={18} aria-hidden="true" />
            {t('quota_pool.show_emails')}
          </label>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void state.refresh()}
            disabled={!state.connected || initialLoading || Boolean(refreshing)}
          >
            <IconRefreshCw size={18} aria-hidden="true" />
            {initialLoading
              ? t('common.loading')
              : t(`quota_pool.${refreshing ? 'refreshing' : 'refresh_all'}`)}
          </button>
        </div>
      </header>
      <div className={styles.providerBar} role="group" aria-label={t('quota_pool.providers')}>
        {(['all', 'claude', 'codex'] as const).map((item) => (
          <button
            type="button"
            key={item}
            aria-pressed={provider === item}
            disabled={chartUnavailable}
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
      <fieldset
        className={styles.toolbar}
        disabled={chartUnavailable}
        aria-label={t('quota_pool.chart_mode')}
      >
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
          <label className={styles.selectLabel}>
            {t('quota_pool.window')}
            <select
              value={query.window}
              onChange={(event) => change('window', event.target.value as PoolQuery['window'])}
            >
              <option value="weekly">{t('quota_pool.weekly')}</option>
              <option value="five-hour">{t('quota_pool.five_hour')}</option>
            </select>
          </label>
        </div>
        <div className={styles.dateNavigation}>
          <span>
            {data
              ? `${date(data.fromMs, true)} – ${date(data.toMs, true)}`
              : t(`quota_pool.${initialLoading ? 'awaiting_data' : 'forecast_unavailable'}`)}
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
      {!chartUnavailable && <p className={styles.method}>{t('quota_pool.normalized_short')}</p>}
      {mode !== 'remaining' && (
        <p id="pool-recorded-only" className={styles.stateNote}>
          {t('quota_pool.recorded_only')}
        </p>
      )}
      {!state.connected && (
        <div className={styles.notice} role="status">
          {t('quota_pool.disconnected')}
        </div>
      )}
      {(state.error || state.refreshError) && (
        <div className={`${styles.notice} ${styles.errorNotice}`} role="alert">
          <div>
            <h2>{t(`quota_pool.${data ? 'refresh_failed_title' : 'load_failed_title'}`)}</h2>
            <p>
              {t(
                `quota_pool.${state.refreshError ? 'refresh_error' : data ? 'load_error' : 'load_error_initial'}`
              )}
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
        <div className={styles.notice} role="status" key={`${issue.provider}-${issue.code}`}>
          {t(`quota_pool.${issue.provider}`)}: {t(`quota_pool.issue.${issue.code}`)}
        </div>
      ))}
      {!data && state.loading && state.connected && (
        <div className={styles.loading} role="status">
          <span className={styles.loadingDot} />
          <h2>{t('quota_pool.loading')}</h2>
        </div>
      )}
      <div className={styles.pools} aria-busy={state.loading}>
        {data?.pools
          .filter((pool) => provider === 'all' || provider === pool.provider)
          .map((pool) => (
            <PoolCard
              key={pool.provider}
              pool={pool}
              dashboard={data}
              mode={mode}
              reveal={query.reveal}
              savedData={state.error || state.refreshError}
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
        <p className={styles.method}>{t('quota_pool.normalized')}</p>
        <p className={styles.method}>{t('quota_pool.limit_note')}</p>
        <span>{t('quota_pool.polling')}</span>
        {data && (
          <>
            <span>
              {t('quota_pool.history_since')}: {date(data.historyStartedAtMs)}
            </span>
            <span>
              {t('quota_pool.last_refresh')}: {date(refreshStatus?.lastRefreshAtMs ?? null)}
            </span>
            <span>
              {t('quota_pool.next_refresh')}: {date(refreshStatus?.nextRefreshAtMs ?? null)}
            </span>
          </>
        )}
      </footer>
    </div>
  );
}
