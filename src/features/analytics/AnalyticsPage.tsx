import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalyticsQuery, AnalyticsRequest } from '@/domain/analytics/types';
import { Button } from '@/components/ui/Button';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconInbox,
  IconRefreshCw,
  IconSearch,
  IconX,
} from '@/components/ui/icons';
import { useAnalytics } from './useAnalytics';
import {
  analyticsTab,
  analyticsTabs,
  bucketQuery,
  buckets,
  nextPageQuery,
  rangeQuery,
  ranges,
  withoutCursor,
  type AnalyticsBucket,
  type AnalyticsRange,
  type AnalyticsTab,
  addressProvider,
  startingFilters,
} from './queryState';
import { AnalyticsViews } from './AnalyticsViews';
import { ModelRates } from './ModelRates';
import { RequestTable } from './RequestTable';
import { analyticsTime } from './format';
import { readAnalyticsUiState, writeAnalyticsUiState } from './uiState';
import styles from './AnalyticsPage.module.scss';

// Card counts per view, for loading placeholders that match the loaded layout.
const skeletonCards: Record<AnalyticsTab, number> = {
  overview: 8,
  tokens: 6,
  cost: 3,
  performance: 3,
  requests: 0,
  rates: 0,
};

/** Segmented presets: every option visible, the current one pressed. */
function Pills<T extends string>({
  label,
  values,
  current,
  onPick,
  name,
}: {
  label: string;
  values: readonly T[];
  current: T;
  onPick: (value: T) => void;
  name: (value: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className={styles.segmented}>
      {values.map((value) => (
        <button
          type="button"
          key={value}
          aria-pressed={current === value}
          onClick={() => onPick(value)}
        >
          {name(value)}
        </button>
      ))}
    </div>
  );
}

export function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  // The address wins, then the last view on this machine, then the defaults.
  const [saved] = useState(readAnalyticsUiState);
  const tab = analyticsTab(params.get('tab') ?? saved.tab ?? null);
  const range: AnalyticsRange =
    ranges.find((value) => value === params.get('range')) ?? saved.range ?? '24h';
  const bucket: AnalyticsBucket =
    buckets.find((value) => value === params.get('bucket')) ?? saved.bucket ?? 'auto';
  const urlProvider = addressProvider(params.get('provider'));
  const start = startingFilters(urlProvider, saved);
  const [pages, setPages] = useState<AnalyticsQuery[]>(() => [
    { ...rangeQuery(range, Date.now(), bucket), ...start },
  ]);
  const query = pages[pages.length - 1];
  const [search, setSearch] = useState(start.search ?? '');
  // Keep tab, range and bucket in the address, so a copied link opens this exact view.
  useEffect(() => {
    if (
      params.get('tab') === tab &&
      params.get('range') === range &&
      params.get('bucket') === bucket
    )
      return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', tab);
        next.set('range', range);
        next.set('bucket', bucket);
        return next;
      },
      { replace: true }
    );
  }, [params, setParams, tab, range, bucket]);
  useEffect(() => {
    writeAnalyticsUiState({
      tab,
      range,
      bucket,
      provider: query.provider,
      model: query.model,
      outcome: query.outcome,
      search: query.search,
    });
  }, [tab, range, bucket, query.provider, query.model, query.outcome, query.search]);
  const [refresh, setRefresh] = useState(0);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [bucketSelected, setBucketSelected] = useState(false);
  const [selected, setSelected] = useState<{
    request: AnalyticsRequest;
    query: AnalyticsQuery;
    session: number;
  } | null>(null);
  const { data, error, loading, session, filterOptions } = useAnalytics(query, refresh);
  const activeFilters = [query.provider, query.model, query.search, query.outcome !== 'all'].filter(
    Boolean
  ).length;
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
  // The query was last built for this view; a new view in the address rebuilds it once.
  const builtFor = useRef(`${range}:${bucket}`);
  const applyView = useCallback((value: AnalyticsRange, size: AnalyticsBucket) => {
    builtFor.current = `${value}:${size}`;
    setBucketSelected(false);
    setSelected(null);
    const interval = rangeQuery(value, Date.now(), size);
    setPages((current) => [
      {
        ...withoutCursor(current[current.length - 1]),
        from_ms: interval.from_ms,
        to_ms: interval.to_ms,
        granularity: interval.granularity,
      },
    ]);
  }, []);
  // The address owns the provider too: one that arrives in it (a link, an edited address) starts
  // a fresh view, and otherwise the address follows the filter, so a copied link opens this view.
  const appliedProvider = useRef(query.provider);
  useEffect(() => {
    if (urlProvider && urlProvider !== appliedProvider.current) {
      appliedProvider.current = urlProvider;
      setBucketSelected(false);
      setSelected(null);
      setSearch('');
      setPages([{ ...rangeQuery(range, Date.now(), bucket), ...startingFilters(urlProvider, {}) }]);
    } else if (urlProvider !== query.provider) {
      appliedProvider.current = query.provider;
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (query.provider) next.set('provider', query.provider);
          else next.delete('provider');
          return next;
        },
        { replace: true }
      );
    }
  }, [urlProvider, query.provider, range, bucket, setParams]);
  // Pills, followed links and edited addresses all change the view through the address.
  useEffect(() => {
    if (builtFor.current !== `${range}:${bucket}`) applyView(range, bucket);
  }, [range, bucket, applyView]);
  const resetRange = (value: AnalyticsRange, size = bucket) => {
    // Choosing the current view again re-applies it, clearing a chart drilldown.
    if (value === range && size === bucket) return applyView(value, size);
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('range', value);
        next.set('bucket', size);
        return next;
      },
      { replace: true }
    );
  };
  const reload = () => {
    const interval = rangeQuery(range, Date.now(), bucket);
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
  useHeaderRefresh(reload);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headline}>
          <h1>{t('analytics.title')}</h1>
          <p className={styles.scope}>
            {analyticsTime(query.from_ms, i18n.language)} →{' '}
            {analyticsTime(query.to_ms, i18n.language)} UTC
            {bucketSelected && <span> · {t('analytics.selected_bucket')}</span>}
            {query.search && <span> {`· ${t('analytics.search')}: ${query.search}`}</span>}
          </p>
          {data && (
            <aside className={styles.coverage} aria-label={t('analytics.coverage')}>
              <div>
                <span>
                  {t(
                    `analytics.${data.coverage.raw_complete ? 'retained_complete' : 'partial_coverage'}`
                  )}
                </span>
                <span>
                  {`${t('analytics.updated')}: ${analyticsTime(data.generated_at_ms, i18n.language)} UTC`}
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
          )}
        </div>
      </header>
      <div className={styles.toolbar}>
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
        <div className={styles.filterControls} data-expanded={filtersExpanded}>
          <button
            type="button"
            className={styles.filterToggle}
            aria-label={t('analytics.filters')}
            aria-describedby="analytics-filter-summary"
            aria-expanded={filtersExpanded}
            aria-controls="analytics-filters"
            onClick={() => setFiltersExpanded((expanded) => !expanded)}
          >
            {t('analytics.filters')}
            <span id="analytics-filter-summary">
              {t(bucketSelected ? 'analytics.selected_bucket' : `analytics.ranges.${range}`)}
              {activeFilters > 0 && ` · ${t('analytics.filter_count', { count: activeFilters })}`}
            </span>
            <IconChevronDown size={14} aria-hidden="true" />
          </button>
          <section
            id="analytics-filters"
            className={styles.filters}
            aria-label={t('analytics.filters')}
          >
            <div className={styles.presetRow}>
              <Pills
                label={t('analytics.range')}
                values={ranges}
                current={range}
                onPick={(value) => resetRange(value)}
                name={(value) => t(`analytics.ranges.${value}`)}
              />
              <Pills
                label={t('analytics.bucket')}
                values={buckets}
                current={bucket}
                onPick={(value) => resetRange(range, value)}
                name={(value) => t(`analytics.buckets.${value}`)}
              />
              <div className={styles.actions}>
                <span className={styles.bucketNote}>
                  {t('analytics.current_bucket', {
                    unit: t(`analytics.bucket_units.${query.granularity}`),
                  })}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={activeFilters === 0 && !bucketSelected}
                  title={t('analytics.clear_filters')}
                  onClick={() => {
                    setPages([rangeQuery(range, Date.now(), bucket)]);
                    setBucketSelected(false);
                    setSearch('');
                    setSelected(null);
                  }}
                >
                  <IconX size={13} aria-hidden="true" />
                  <span className={styles.actionLabel}>{t('analytics.clear_filters')}</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={reload}
                  disabled={loading}
                  title={t('analytics.refresh')}
                >
                  <IconRefreshCw size={13} aria-hidden="true" />
                  <span className={styles.actionLabel}>{t('analytics.refresh')}</span>
                </Button>
              </div>
            </div>
            <div className={styles.fieldRow}>
              <form
                className={styles.searchForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  filter({ search: search.trim() || undefined });
                }}
              >
                <label>
                  <IconSearch size={14} aria-hidden="true" />
                  <span className={styles.srOnly}>{t('analytics.search')}</span>
                  <input
                    type="search"
                    value={search}
                    maxLength={200}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('analytics.search_hint')}
                  />
                </label>
                {/* Apply is live only when the typed search differs from the applied one;
                    while the dataset is unavailable, Retry is the one primary action. */}
                <Button
                  type="submit"
                  size="sm"
                  variant={
                    !error && search.trim() !== (query.search ?? '') ? 'primary' : 'secondary'
                  }
                  disabled={search.trim() === (query.search ?? '')}
                >
                  {t('analytics.apply')}
                </Button>
              </form>
              <label>
                <span className={styles.srOnly}>{t('analytics.provider')}</span>
                <select
                  value={query.provider ?? ''}
                  onChange={(event) => filter({ provider: event.target.value || undefined })}
                >
                  <option value="">{t('analytics.all_providers')}</option>
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
                <span className={styles.srOnly}>{t('analytics.model')}</span>
                <select
                  value={query.model ?? ''}
                  onChange={(event) => filter({ model: event.target.value || undefined })}
                >
                  <option value="">{t('analytics.all_models')}</option>
                  {Array.from(
                    new Set([
                      ...(filterOptions?.models ?? []),
                      ...(query.model ? [query.model] : []),
                    ])
                  ).map((model) => (
                    <option key={model}>{model}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className={styles.srOnly}>{t('analytics.outcome')}</span>
                <select
                  value={query.outcome}
                  onChange={(event) =>
                    filter({ outcome: event.target.value as AnalyticsQuery['outcome'] })
                  }
                >
                  <option value="all">{t('analytics.all_outcomes')}</option>
                  <option value="success">{t('analytics.success')}</option>
                  <option value="failed">{t('analytics.failed_outcome')}</option>
                </select>
              </label>
            </div>
          </section>
        </div>
      </div>
      <div
        id="analytics-panel"
        role="tabpanel"
        aria-labelledby={`analytics-tab-${tab}`}
        aria-busy={loading}
        tabIndex={0}
      >
        {/* First load: placeholders in the page's own shape, so nothing jumps when data lands. */}
        {loading && !data && (
          <div role="status" className={styles.skeleton}>
            {skeletonCards[tab] > 0 && (
              <div className={styles.metrics} data-count={skeletonCards[tab]} aria-hidden="true">
                {Array.from({ length: skeletonCards[tab] }, (_, index) => (
                  <span key={index} className={styles.skeletonCard} />
                ))}
              </div>
            )}
            <p className={styles.skeletonChart}>{t('analytics.loading')}</p>
          </div>
        )}
        {loading && data && (
          <p role="status" className={styles.srOnly}>
            {t('analytics.loading')}
          </p>
        )}
        {error && (
          <div role="alert" className={`${styles.emptyState} ${styles.errorState}`}>
            <IconAlertTriangle size={20} aria-hidden="true" />
            <div>
              <h2>{t('analytics.error_title')}</h2>
              <p>{t(`analytics.errors.${error}`)}</p>
              <Button size="sm" variant="primary" onClick={reload}>
                {t('analytics.retry')}
              </Button>
            </div>
          </div>
        )}
        {data && (
          <>
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
