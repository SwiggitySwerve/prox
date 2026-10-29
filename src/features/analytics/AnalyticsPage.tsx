import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalyticsQuery, AnalyticsRequest } from '@/domain/analytics/types';
import { Button } from '@/components/ui/Button';
import { IconAlertTriangle, IconInbox, IconRefreshCw } from '@/components/ui/icons';
import { useAnalytics } from './useAnalytics';
import {
  analyticsTab,
  analyticsTabs,
  bucketQuery,
  nextPageQuery,
  rangeQuery,
  ranges,
  withoutCursor,
  type AnalyticsRange,
} from './queryState';
import { AnalyticsViews } from './AnalyticsViews';
import { ModelRates } from './ModelRates';
import { RequestTable } from './RequestTable';
import { analyticsTime } from './format';
import styles from './AnalyticsPage.module.scss';

export function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = analyticsTab(params.get('tab'));
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const [pages, setPages] = useState<AnalyticsQuery[]>(() => [rangeQuery('24h', Date.now())]);
  const query = pages[pages.length - 1];
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [bucketSelected, setBucketSelected] = useState(false);
  const [selected, setSelected] = useState<{
    request: AnalyticsRequest;
    query: AnalyticsQuery;
    session: number;
  } | null>(null);
  const { data, error, loading, session, filterOptions } = useAnalytics(query, refresh);
  const setTab = (value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', value);
        return next;
      },
      { replace: true }
    );
  const filter = (changes: Partial<AnalyticsQuery>) => {
    setSelected(null);
    setPages([{ ...withoutCursor(query), ...changes }]);
  };
  const drilldown = (next: AnalyticsQuery) => {
    setSelected(null);
    setPages([next]);
    setTab('requests');
  };
  const next = data ? nextPageQuery(query, data.requests) : null;
  const resetRange = (value: AnalyticsRange) => {
    setRange(value);
    setBucketSelected(false);
    const interval = rangeQuery(value, Date.now());
    filter({ from_ms: interval.from_ms, to_ms: interval.to_ms, granularity: interval.granularity });
  };
  const reload = () => {
    const interval = rangeQuery(range, Date.now());
    setSelected(null);
    setBucketSelected(false);
    setPages([
      {
        ...withoutCursor(query),
        from_ms: interval.from_ms,
        to_ms: interval.to_ms,
        granularity: interval.granularity,
      },
    ]);
    setRefresh((value) => value + 1);
  };
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t('analytics.title')}</h1>
          <p>{t('analytics.subtitle')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
          <IconRefreshCw size={15} /> {t('analytics.refresh')}
        </Button>
      </header>
      <section className={styles.filters} aria-label={t('analytics.filters')}>
        <label>
          {t('analytics.range')}
          <select
            value={range}
            onChange={(event) => resetRange(event.target.value as AnalyticsRange)}
          >
            {ranges.map((value) => (
              <option key={value} value={value}>
                {t(`analytics.ranges.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('analytics.provider')}
          <select
            value={query.provider ?? ''}
            onChange={(event) => filter({ provider: event.target.value || undefined })}
          >
            <option value="">{t('analytics.all')}</option>
            {Array.from(
              new Set([
                ...(filterOptions?.providers ?? []),
                ...(query.provider ? [query.provider] : []),
              ])
            ).map((provider) => (
              <option key={provider}>{provider}</option>
            ))}
          </select>
        </label>
        <label>
          {t('analytics.model')}
          <select
            value={query.model ?? ''}
            onChange={(event) => filter({ model: event.target.value || undefined })}
          >
            <option value="">{t('analytics.all')}</option>
            {Array.from(
              new Set([...(filterOptions?.models ?? []), ...(query.model ? [query.model] : [])])
            ).map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
        </label>
        <label>
          {t('analytics.outcome')}
          <select
            value={query.outcome}
            onChange={(event) =>
              filter({ outcome: event.target.value as AnalyticsQuery['outcome'] })
            }
          >
            <option value="all">{t('analytics.all')}</option>
            <option value="success">{t('analytics.success')}</option>
            <option value="failed">{t('analytics.failed_outcome')}</option>
          </select>
        </label>
        <form
          className={styles.searchForm}
          onSubmit={(event) => {
            event.preventDefault();
            filter({ search: search.trim() || undefined });
          }}
        >
          <label>
            {t('analytics.search')}
            <input
              type="search"
              value={search}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('analytics.search_hint')}
            />
          </label>
          <Button type="submit" size="sm" variant="primary">
            {t('analytics.apply')}
          </Button>
        </form>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setPages([rangeQuery(range, Date.now())]);
            setBucketSelected(false);
            setSearch('');
            setSelected(null);
          }}
        >
          {t('analytics.clear_filters')}
        </Button>
      </section>
      <p className={styles.scope}>
        {analyticsTime(query.from_ms, i18n.language)} → {analyticsTime(query.to_ms, i18n.language)}{' '}
        UTC{bucketSelected && <span> · {t('analytics.selected_bucket')}</span>}
        {query.search && (
          <span>
            {' '}
            · {t('analytics.search')}: {query.search}
          </span>
        )}
      </p>
      <nav className={styles.tabs} aria-label={t('analytics.views')} role="tablist">
        {analyticsTabs.map((value) => (
          <button
            type="button"
            id={`analytics-tab-${value}`}
            key={value}
            role="tab"
            aria-selected={tab === value}
            aria-controls="analytics-panel"
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const index = analyticsTabs.indexOf(value);
              const target =
                event.key === 'ArrowRight'
                  ? analyticsTabs[(index + 1) % analyticsTabs.length]
                  : event.key === 'ArrowLeft'
                    ? analyticsTabs[(index + analyticsTabs.length - 1) % analyticsTabs.length]
                    : event.key === 'Home'
                      ? analyticsTabs[0]
                      : event.key === 'End'
                        ? analyticsTabs[analyticsTabs.length - 1]
                        : undefined;
              if (target) {
                event.preventDefault();
                setTab(target);
                document.getElementById(`analytics-tab-${target}`)?.focus();
              }
            }}
          >
            {t(`analytics.tabs.${value}`)}
          </button>
        ))}
      </nav>
      <div
        id="analytics-panel"
        role="tabpanel"
        aria-labelledby={`analytics-tab-${tab}`}
        aria-busy={loading}
        tabIndex={0}
      >
        {loading && (
          <p role="status" className={styles.state}>
            {t('analytics.loading')}
          </p>
        )}
        {error && (
          <div role="alert" className={`${styles.state} ${styles.errorState}`}>
            <h2>
              <IconAlertTriangle size={18} aria-hidden="true" />
              {t('analytics.error_title')}
            </h2>
            <p>{t(`analytics.errors.${error}`)}</p>
            <Button size="sm" variant="primary" onClick={reload}>
              {t('analytics.retry')}
            </Button>
          </div>
        )}
        {data && (
          <>
            <aside className={styles.coverage} aria-label={t('analytics.coverage')}>
              <div>
                <strong>{t('analytics.retained_scope')}</strong>
                <span>
                  {t(
                    `analytics.${data.coverage.raw_complete ? 'retained_complete' : 'partial_coverage'}`
                  )}
                </span>
                <span>
                  {t('analytics.updated')}: {analyticsTime(data.generated_at_ms, i18n.language)} UTC
                </span>
              </div>
              <details>
                <summary>{t('analytics.coverage_limits')}</summary>
                <p>{t('analytics.coverage_note')}</p>
                <p>
                  {t('analytics.price_note')} · {t('analytics.revision')}:{' '}
                  {data.coverage.price_revision}
                </p>
                <p>
                  {t('analytics.source_attribution')}:{' '}
                  {t(`analytics.attribution.${data.coverage.source_attribution}`)} ·{' '}
                  {t('analytics.fields.timing_method')}: {data.coverage.timing_method}
                </p>
                {data.coverage.limitations.length > 0 && (
                  <ul>
                    {data.coverage.limitations.map((limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ))}
                  </ul>
                )}
              </details>
            </aside>
            {data.summary.calls === 0 && tab !== 'rates' && (
              <div className={styles.emptyState} role="status">
                <IconInbox size={20} aria-hidden="true" />
                <div>
                  <h2>{t('analytics.empty_title')}</h2>
                  <p>
                    {t(
                      query.provider || query.model || query.search || query.outcome !== 'all'
                        ? 'analytics.empty'
                        : 'analytics.empty_unfiltered'
                    )}
                  </p>
                </div>
              </div>
            )}
            {tab === 'rates' ? (
              <ModelRates data={data} />
            ) : tab === 'requests' ? (
              <RequestTable
                data={data.requests}
                selected={
                  selected?.query === query && selected.session === session
                    ? selected.request
                    : null
                }
                onSelect={(request) => setSelected(request ? { request, query, session } : null)}
                page={pages.length}
                providerLabels={new Map(data.providers.map((p) => [p.key, p.label]))}
                canPrevious={pages.length > 1}
                canNext={next !== null}
                onPrevious={() => {
                  setSelected(null);
                  setPages((current) => current.slice(0, -1));
                }}
                onNext={() => {
                  if (next) {
                    setSelected(null);
                    setPages((current) => [...current, next]);
                  }
                }}
              />
            ) : (
              <AnalyticsViews
                tab={tab}
                data={data}
                onBucket={(bucket) => {
                  setBucketSelected(true);
                  drilldown(bucketQuery(query, bucket));
                }}
                onModel={(model) => drilldown({ ...withoutCursor(query), model })}
                onProvider={(provider) => drilldown({ ...withoutCursor(query), provider })}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
