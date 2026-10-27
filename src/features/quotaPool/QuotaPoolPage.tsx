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
        <div>
          <h1>{t('quota_pool.title')}</h1>
        </div>
        <div className={styles.actions}>
          <label className={styles.privacy}>
            <input
              type="checkbox"
              checked={query.reveal}
              onChange={(event) => change('reveal', event.target.checked)}
            />
            <IconEye size={18} aria-hidden="true" />
            {t('quota_pool.show_emails')}
          </label>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void state.refresh()}
            disabled={!state.connected || Boolean(refreshing)}
          >
            <IconRefreshCw size={18} aria-hidden="true" />
            {t(`quota_pool.${refreshing ? 'refreshing' : 'refresh_all'}`)}
          </button>
        </div>
      </header>
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
            {item !== 'all' && (
              <span className={styles.count}>
                {data?.pools.find((pool) => pool.provider === item)?.accountCount ?? '—'}
              </span>
            )}
          </button>
        ))}
        <Link to="/quota/accounts" className={styles.accountLink}>
          {t('quota_pool.account_view')} <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <div className={styles.toolbar}>
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
        <div className={styles.segment} role="group" aria-label={t('quota_pool.rate_interval')}>
          {([1, 3, 6] as const).map((hours) => (
            <button
              type="button"
              key={hours}
              aria-pressed={query.lookback === hours}
              onClick={() => change('lookback', hours)}
            >
              {t('quota_pool.hours', { hours })}
            </button>
          ))}
        </div>
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
          <span className={styles.srOnly}>{t('quota_pool.window')}</span>
          <select
            value={query.window}
            onChange={(event) => change('window', event.target.value as PoolQuery['window'])}
          >
            <option value="weekly">{t('quota_pool.weekly')}</option>
            <option value="five-hour">{t('quota_pool.five_hour')}</option>
          </select>
        </label>
        <div className={styles.dateNavigation}>
          <span>{data ? `${date(data.fromMs, true)} – ${date(data.toMs, true)}` : '—'}</span>
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
      </div>
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
        <div className={styles.notice} role="alert">
          {t(`quota_pool.${state.refreshError ? 'refresh_error' : 'load_error'}`)}{' '}
          <button
            type="button"
            onClick={() => void (state.refreshError ? state.refresh() : state.reload())}
          >
            {t('quota_pool.retry')}
          </button>
          {data && (
            <p>
              {t('quota_pool.last_refresh')}: {date(data.lastRefreshAtMs)}
            </p>
          )}
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
          {t('quota_pool.loading')}
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
            />
          ))}
        {data && data.pools.length === 0 && (
          <div className={styles.notice}>
            <p>{t('quota_pool.state_note.no-accounts')}</p>
            <Link to="/quota/accounts" className={styles.accountLink}>
              {t('quota_pool.account_view')}
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
