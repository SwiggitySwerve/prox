import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw, IconUpload } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/features/authFiles/constants';
import { countCredentials } from '@/features/authFiles/credentialFacts';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { AuthFilesToolbar } from '@/features/authFiles/components/AuthFilesToolbar';
import { useAuthFilesFilters } from '@/features/authFiles/hooks/useAuthFilesFilters';
import {
  INITIAL_PAGE_QUOTA_REFRESH,
  pageQuotaRefreshReducer,
} from '@/features/authFiles/quotaSlot';
import {
  OTHER_PROVIDER_GROUP,
  UNKNOWN,
  healthParts,
  matchesStatusFilter,
  providerGroupOf,
  resolveProviderFilter,
  resolveSourceFilter,
  summarizeSources,
  type AuthFilesFilters,
  type SourceAnswer,
} from '@/features/authFiles/unifiedList';
import type { AuthFilesStatusFilterMode } from '@/features/authFiles/uiState';
import { useThemeStore } from '@/stores';
import {
  ALL_SOURCES,
  AuthFilesSourceNav,
} from '@/features/authFiles/components/AuthFilesSourceNav';
import { useProviderSources } from '@/stores/useProviderSources';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
} from '@/stores/useCredentialInventoryStore';
import type { SourceView } from '@/services/providerSources/registry';
import type { AuthFileItem } from '@/types';
import { AuthFilesSourceProvider } from './AuthFilesSourceContext';
import {
  AuthFilesSourceContent,
  CardRowBlock,
  GroupMenu,
  type AnswerState,
  type QuotaRunner,
  type RegisterQuotaRefresh,
  type RegisterRefresh,
  type RegisterUpload,
  type ReportAnswer,
} from './AuthFilesSourceContent';
import styles from './AuthFilesPage.module.scss';

/**
 * Auth Files across every source: one header, one filter bar, results grouped by source and then
 * by provider. Each source group keeps its own actions, selection and pagination, because writes
 * belong to one source; the filters and the credential data are shared.
 */
export function AuthFilesPage() {
  const { status, sources } = useProviderSources();
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const refreshers = useRef(new Map<string, () => Promise<void>>());
  const registerRefresh = useCallback((key: string, refresh: () => Promise<void>) => {
    refreshers.current.set(key, refresh);
    return () => {
      refreshers.current.delete(key);
    };
  }, []);
  const refreshAllSources = useCallback(async () => {
    await Promise.allSettled([...refreshers.current.values()].map((refresh) => refresh()));
  }, []);
  useHeaderRefresh(refreshAllSources);

  // One "Refresh quota" for the whole page: every group registers what it shows that has quota.
  const quotaRunners = useRef(new Map<string, QuotaRunner>());
  const [quotaCounts, setQuotaCounts] = useState<Record<string, number>>({});
  const registerQuotaRefresh = useCallback<RegisterQuotaRefresh>((key, runner) => {
    quotaRunners.current.set(key, runner);
    setQuotaCounts((prev) =>
      prev[key] === runner.count ? prev : { ...prev, [key]: runner.count }
    );
    return () => {
      quotaRunners.current.delete(key);
      setQuotaCounts((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };
  }, []);
  const [quotaRun, dispatchQuotaRun] = useReducer(
    pageQuotaRefreshReducer,
    INITIAL_PAGE_QUOTA_REFRESH
  );
  const quotaRunning = quotaRun.status === 'running';
  const refreshShownQuota = useCallback(async () => {
    const runners = [...quotaRunners.current.values()].filter((runner) => runner.count > 0);
    const total = runners.reduce((sum, runner) => sum + runner.count, 0);
    if (total === 0) return;
    dispatchQuotaRun({ type: 'start', total });
    const onSettled = (ok: boolean) => dispatchQuotaRun({ type: 'settled', ok });
    await Promise.allSettled(runners.map((runner) => runner.run(onSettled)));
    dispatchQuotaRun({ type: 'finish' });
  }, []);
  const quotaShown = Object.values(quotaCounts).reduce((sum, count) => sum + count, 0);

  // Each source group reports whether it has answered once and whether its last read failed.
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const reportAnswer = useCallback((instanceId: string, state: AnswerState) => {
    setAnswers((prev) => (prev[instanceId] === state ? prev : { ...prev, [instanceId]: state }));
  }, []);
  // The page-level empty state uploads through the group that owns the source.
  const uploaders = useRef(new Map<string, () => void>());
  const registerUpload = useCallback((instanceId: string, upload: () => void) => {
    uploaders.current.set(instanceId, upload);
    return () => {
      uploaders.current.delete(instanceId);
    };
  }, []);

  const filterState = useAuthFilesFilters(sources[0]?.source.instanceId);
  const { filters } = filterState;

  // One read of the shared credential store for the page-wide totals, chips and counts.
  const inventorySources = useCredentialInventoryStore((state) => state.sources);
  const loadable = sources.filter((view) => view.status === 'ready' && view.session);
  const filesBySource = useMemo(() => {
    const result: Record<string, AuthFileItem[] | undefined> = {};
    for (const view of sources) {
      if (!view.session) continue;
      result[view.source.instanceId] = selectSourceFiles(
        { sources: inventorySources },
        view.session.owner
      );
    }
    return result;
  }, [inventorySources, sources]);
  const answerOf = (instanceId: string): SourceAnswer => ({
    state: answers[instanceId] ?? 'loading',
    files: filesBySource[instanceId],
  });
  /** Known: answered at least once and its files are in the inventory (stale ones count). */
  const isKnown = (instanceId: string) =>
    answerOf(instanceId).state !== 'loading' && filesBySource[instanceId] !== undefined;

  // A persisted source or provider that no longer applies means "all", and the controls say so.
  const effectiveSource = resolveSourceFilter(
    filters.source,
    sources.map((view) => view.source.instanceId)
  );
  const inScope = (instanceId: string) =>
    effectiveSource === ALL_SOURCES || effectiveSource === instanceId;
  const scopedLoadable = loadable.filter((view) => inScope(view.source.instanceId));
  const scopedKnown = scopedLoadable.every((view) => isKnown(view.source.instanceId));
  const scopedFiles = scopedLoadable.flatMap((view) => filesBySource[view.source.instanceId] ?? []);
  const providerTypes = [
    'all',
    ...[...new Set(scopedFiles.map(providerGroupOf))].sort(
      (a, b) =>
        Number(a === OTHER_PROVIDER_GROUP) - Number(b === OTHER_PROVIDER_GROUP) ||
        a.localeCompare(b)
    ),
  ];
  const effectiveProvider = resolveProviderFilter(filters.provider, providerTypes);
  const statusFiltered = scopedFiles.filter((file) =>
    matchesStatusFilter(file, filters.statusFilterMode)
  );
  const providerCounts: Record<string, number> = { all: statusFiltered.length };
  statusFiltered.forEach((file) => {
    const key = providerGroupOf(file);
    providerCounts[key] = (providerCounts[key] ?? 0) + 1;
  });
  // Unknown counts are omitted (the pill shows none) rather than shown as 0.
  const sourceCounts: Record<string, number> = {};
  loadable.forEach((view) => {
    const id = view.source.instanceId;
    if (isKnown(id)) sourceCounts[id] = filesBySource[id]?.length ?? 0;
  });
  if (loadable.length > 0 && loadable.every((view) => isKnown(view.source.instanceId))) {
    sourceCounts[ALL_SOURCES] = loadable.reduce(
      (sum, view) => sum + (filesBySource[view.source.instanceId]?.length ?? 0),
      0
    );
  }

  // The chips count the credentials the provider tab and source pills leave in view.
  const chipCounts = scopedKnown
    ? countCredentials(
        effectiveProvider === 'all'
          ? scopedFiles
          : scopedFiles.filter((file) => providerGroupOf(file) === effectiveProvider)
      )
    : null;
  const statusFilterOptions: Array<{
    value: AuthFilesStatusFilterMode;
    label: string;
    count?: number | null;
  }> = [
    { value: 'all', label: t('auth_files.problem_filter_all'), count: chipCounts?.total ?? null },
    {
      value: 'enabled',
      label: t('auth_files.problem_filter_enabled'),
      count: chipCounts?.active ?? null,
    },
    {
      value: 'disabled',
      label: t('auth_files.problem_filter_disabled'),
      count: chipCounts?.disabled ?? null,
    },
    {
      value: 'problem',
      label: t('auth_files.problem_filter_problem'),
      count: chipCounts?.problem ?? null,
    },
  ];
  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('auth_files.sort_default') },
      { value: 'az', label: t('auth_files.sort_az') },
      { value: 'priority', label: t('auth_files.sort_priority') },
    ],
    [t]
  );

  const summary = summarizeSources(loadable.map((view) => answerOf(view.source.instanceId)));
  const summaryCounts = summary.status === 'ready' ? summary.counts : null;
  const summaryText = [
    t('auth_files.unified_summary', {
      total: summaryCounts?.total ?? UNKNOWN,
      sources: summary.status === 'ready' ? summary.sources : loadable.length,
    }),
    ...healthParts(t, summaryCounts),
    summary.status === 'ready' && summary.unreachable > 0
      ? t('auth_files.summary_unreachable', { count: summary.unreachable })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const quotaButtonTitle = filters.compactMode
    ? t('auth_files.quota_refresh_all_compact')
    : quotaRun.status === 'done' && quotaRun.failed > 0
      ? t('auth_files.quota_refresh_all_outcome', {
          loaded: quotaRun.settled - quotaRun.failed,
          total: quotaRun.total,
          failed: quotaRun.failed,
        })
      : quotaShown === 0
        ? t('auth_files.quota_refresh_all_none')
        : t('auth_files.quota_refresh_all_hint', { count: quotaShown });

  // Every source in view answered and has nothing: one page-level empty state, not one per source.
  const pageEmpty =
    scopedLoadable.length > 0 &&
    scopedLoadable.every(
      (view) =>
        answerOf(view.source.instanceId).state === 'ready' &&
        filesBySource[view.source.instanceId]?.length === 0
    );

  const groupFilters: AuthFilesFilters = {
    ...filters,
    provider: effectiveProvider,
    source: effectiveSource,
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>{t('auth_files.unified_title')}</h1>
        <p className={styles.pageSummary}>
          {summaryText}
          {summary.status === 'loading' && (
            <span role="status" className={styles.srOnly}>
              {t('auth_files.summary_loading')}
            </span>
          )}
        </p>
      </header>
      {status === 'loading' && <div role="status">{t('common.loading')}</div>}
      {(status === 'error' || status === 'disconnected') && (
        <div role="alert" className={styles.errorBanner}>
          {t('provider_sources.discovery_error')}
        </div>
      )}

      <section className={styles.filterBar} aria-label={t('auth_files.unified_filters_label')}>
        <AuthFilesSourceNav
          sources={sources}
          counts={sourceCounts}
          active={effectiveSource}
          onChange={filterState.setSource}
        />
        <ProviderTabs
          types={providerTypes}
          counts={scopedKnown ? providerCounts : null}
          active={effectiveProvider}
          resolvedTheme={resolvedTheme}
          onChange={filterState.setProvider}
        />
        <AuthFilesToolbar
          search={filters.search}
          onSearchChange={filterState.setSearch}
          statusFilterMode={filters.statusFilterMode}
          statusFilterOptions={statusFilterOptions}
          onStatusFilterChange={filterState.setStatusFilterMode}
          sortMode={filters.sortMode}
          sortOptions={sortOptions}
          onSortModeChange={filterState.setSortMode}
          pageSizeInput={filterState.pageSizeInput}
          onPageSizeInputChange={filterState.handlePageSizeChange}
          onPageSizeCommit={filterState.commitPageSizeInput}
          compactMode={filters.compactMode}
          onCompactModeChange={filterState.setCompactMode}
          quotaRefresh={{
            label: quotaRunning
              ? t('auth_files.quota_refresh_all_progress', {
                  done: quotaRun.settled,
                  total: quotaRun.total,
                })
              : t('auth_files.quota_refresh_all'),
            title: quotaButtonTitle,
            running: quotaRunning,
            disabled: quotaRunning || filters.compactMode || quotaShown === 0,
            onClick: () => void refreshShownQuota(),
            outcome:
              quotaRun.status === 'done'
                ? t('auth_files.quota_refresh_all_outcome', {
                    loaded: quotaRun.settled - quotaRun.failed,
                    total: quotaRun.total,
                    failed: quotaRun.failed,
                  })
                : '',
          }}
        />
      </section>

      {pageEmpty && (
        <CardRowBlock compact={filters.compactMode}>
          <EmptyState
            title={t('auth_files.empty_title')}
            description={t('auth_files.empty_desc')}
            action={
              <div className={styles.emptyActions}>
                {scopedLoadable.map((view) => (
                  <Button
                    key={view.source.instanceId}
                    size="sm"
                    onClick={() => uploaders.current.get(view.source.instanceId)?.()}
                  >
                    <IconUpload size={14} aria-hidden="true" />{' '}
                    {scopedLoadable.length > 1
                      ? t('auth_files.upload_to_source', { source: view.source.label })
                      : t('auth_files.upload_button')}
                  </Button>
                ))}
              </div>
            }
          />
        </CardRowBlock>
      )}

      {sources.map((view) => (
        <AuthFilesSourcePanel
          key={view.source.instanceId}
          view={view}
          hidden={!inScope(view.source.instanceId)}
          pageEmpty={pageEmpty}
          filters={groupFilters}
          onClearFilters={filterState.clear}
          registerRefresh={registerRefresh}
          registerUpload={registerUpload}
          registerQuotaRefresh={registerQuotaRefresh}
          onAnswer={reportAnswer}
        />
      ))}
    </div>
  );
}

export function AuthFilesSourcePanel({
  view,
  hidden,
  pageEmpty = false,
  filters,
  onClearFilters,
  registerRefresh,
  registerUpload,
  registerQuotaRefresh,
  onAnswer,
}: {
  view: SourceView;
  hidden: boolean;
  /** The page shows one empty state for every source; the group keeps only its upload input. */
  pageEmpty?: boolean;
  filters: AuthFilesFilters;
  onClearFilters: () => void;
  registerRefresh: RegisterRefresh;
  registerUpload?: RegisterUpload;
  registerQuotaRefresh?: RegisterQuotaRefresh;
  onAnswer?: ReportAnswer;
}) {
  const { t } = useTranslation();
  const signInText =
    view.status === 'unauthorized'
      ? t('provider_sources.authentication_required')
      : t('auth_files.source_authentication_required', {
          defaultValue: 'Sign in to this source to view its auth files.',
        });
  return (
    <section
      className={styles.sourcePanel}
      aria-label={view.source.label}
      data-source-id={view.source.instanceId}
      hidden={hidden}
    >
      {view.status === 'ready' && view.session ? (
        <AuthFilesSourceProvider source={view.source} session={view.session}>
          <AuthFilesSourceContent
            hidden={hidden}
            pageEmpty={pageEmpty}
            filters={filters}
            onClearFilters={onClearFilters}
            registerRefresh={registerRefresh}
            registerUpload={registerUpload}
            registerQuotaRefresh={registerQuotaRefresh}
            onAnswer={onAnswer}
          />
        </AuthFilesSourceProvider>
      ) : (
        // The same header parts as a signed-in group, with nothing to act on yet.
        <div className={styles.sourceGroup}>
          <header className={styles.groupHeader}>
            <div className={styles.groupTitle}>
              <h2 className={styles.sourceHeading}>
                {view.source.label} <code>{view.source.instanceId}</code>
              </h2>
              <p className={styles.groupMeta}>
                <span>
                  {t('auth_files.unified_group_count', { shown: UNKNOWN, total: UNKNOWN })}
                </span>
                {healthParts(t, null).map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </p>
            </div>
            <div className={styles.groupActions}>
              <Button variant="ghost" size="sm" disabled title={signInText}>
                <IconRefreshCw size={14} aria-hidden="true" /> {t('auth_files.refresh_all_short')}
              </Button>
              <Button variant="ghost" size="sm" disabled title={signInText}>
                <IconUpload size={14} aria-hidden="true" /> {t('auth_files.upload_button')}
              </Button>
              <GroupMenu
                label={t('auth_files.more_actions', { source: view.source.label })}
                items={[
                  {
                    key: 'delete-shown',
                    label: t('auth_files.delete_shown_menu', { count: 0 }),
                    danger: true,
                    disabled: true,
                    run: () => {},
                  },
                ]}
              />
            </div>
          </header>
          <CardRowBlock compact={filters.compactMode}>
            <div className={`${styles.errorBanner} ${styles.errorBlock}`} role="alert">
              {signInText}
            </div>
          </CardRowBlock>
        </div>
      )}
    </section>
  );
}
