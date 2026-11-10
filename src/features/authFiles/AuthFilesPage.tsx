import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconRefreshCw, IconTrash2, IconUpload } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  QUOTA_PROVIDER_TYPES,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  type AuthFileQuotaFilter,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { countCredentials, type CredentialCounts } from '@/features/authFiles/credentialFacts';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileDetailsSheet } from '@/features/authFiles/components/AuthFileDetailsSheet';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { AuthFileRefreshResults } from '@/features/authFiles/components/AuthFileRefreshResults';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesToolbar } from '@/features/authFiles/components/AuthFilesToolbar';
import { BatchActionBar } from '@/features/authFiles/components/BatchActionBar';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { invalidateAuthFileDerivedCaches } from '@/features/authFiles/cacheInvalidation';
import { sortAuthFiles } from '@/features/authFiles/logic';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { useAuthFilesFilters } from '@/features/authFiles/hooks/useAuthFilesFilters';
import {
  OTHER_PROVIDER_GROUP,
  deletableShown,
  filterAuthFiles,
  groupByProvider,
  listLoadState,
  matchesStatusFilter,
  modelsScreenPath,
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
import { sourceOwnerKey } from '@/services/api/sourceSession';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
} from '@/stores/useCredentialInventoryStore';
import type { SourceView } from '@/services/providerSources/registry';
import type { AuthFileItem } from '@/types';
import {
  AuthFilesSourceProvider,
  useAuthFilesSource,
  useAuthFilesNotifications,
} from './AuthFilesSourceContext';
import styles from './AuthFilesPage.module.scss';

const SKELETON_CARD_COUNT = 6;
/** First-render cascade budget for cards, the same 360 ms vocabulary as useRevealGroup. */
const CARD_ENTRANCE_BUDGET_MS = 360;

type AnswerState = SourceAnswer['state'];

/** "A active · P with problems · D disabled": zero parts are left out, except active. */
function healthParts(t: TFunction, counts: CredentialCounts) {
  return [
    t('auth_files.meta_active', { count: counts.active }),
    counts.problem > 0 ? t('auth_files.meta_problem', { count: counts.problem }) : null,
    counts.disabled > 0 ? t('auth_files.meta_disabled', { count: counts.disabled }) : null,
  ].filter((part): part is string => part !== null);
}

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
  const summaryText =
    summary.status === 'loading'
      ? t('auth_files.summary_loading')
      : [
          t('auth_files.unified_summary', {
            total: summary.counts.total,
            sources: summary.sources,
          }),
          ...healthParts(t, summary.counts),
          summary.unreachable > 0
            ? t('auth_files.summary_unreachable', { count: summary.unreachable })
            : null,
        ]
          .filter(Boolean)
          .join(' · ');

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
        <p
          className={styles.pageSummary}
          role={summary.status === 'loading' ? 'status' : undefined}
        >
          {summaryText}
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
        />
      </section>

      {pageEmpty && (
        <div className={styles.emptyWrap}>
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
        </div>
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
          onAnswer={reportAnswer}
        />
      ))}
    </div>
  );
}

type RegisterRefresh = (key: string, refresh: () => Promise<void>) => () => void;
type RegisterUpload = (instanceId: string, upload: () => void) => () => void;
type ReportAnswer = (instanceId: string, state: AnswerState) => void;

export function AuthFilesSourcePanel({
  view,
  hidden,
  pageEmpty = false,
  filters,
  onClearFilters,
  registerRefresh,
  registerUpload,
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
  onAnswer?: ReportAnswer;
}) {
  const { t } = useTranslation();
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
            onAnswer={onAnswer}
          />
        </AuthFilesSourceProvider>
      ) : (
        <>
          <h2 className={styles.sourceHeading}>
            {view.source.label} <code>{view.source.instanceId}</code>
          </h2>
          <div className={styles.errorBanner} role="alert">
            {view.status === 'unauthorized'
              ? t('provider_sources.authentication_required')
              : t('auth_files.source_authentication_required', {
                  defaultValue: 'Sign in to this source to view its auth files.',
                })}
          </div>
        </>
      )}
    </section>
  );
}

/** Secondary group actions behind one "More" button, so a phone header stays one row. */
function GroupMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{
    key: string;
    label: string;
    danger?: boolean;
    disabled?: boolean;
    run: () => void;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ];
      if (buttons.length === 0) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.groupMenu} ref={rootRef}>
      {/* The shared Button takes no ref; the trigger needs one to get focus back on Escape. */}
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" className={styles.moreGlyph}>
          ⋯
        </span>
      </button>
      {open && (
        <div className={styles.groupMenuPopover} role="menu" aria-label={label} ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? styles.groupMenuDanger : undefined}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                item.run();
              }}
            >
              {item.danger && <IconTrash2 size={14} aria-hidden="true" />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AuthFilesSourceContent({
  hidden,
  pageEmpty,
  filters,
  onClearFilters,
  registerRefresh,
  registerUpload,
  onAnswer,
}: {
  hidden: boolean;
  pageEmpty: boolean;
  filters: AuthFilesFilters;
  onClearFilters: () => void;
  registerRefresh: RegisterRefresh;
  registerUpload?: RegisterUpload;
  onAnswer?: ReportAnswer;
}) {
  const { t } = useTranslation();
  const sourceScope = useAuthFilesSource();
  const { showNotification } = useAuthFilesNotifications();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  // Every filter change returns this group to its first page.
  useEffect(() => setPage(1), [filters.revision]);

  const {
    modelsModalOpen,
    modelsFile,
    showModels,
    reloadModels,
    closeModelsModal,
    invalidateModels,
  } = useAuthFilesModels();

  const invalidateDerivedCaches = useCallback(
    (names?: string[]) =>
      invalidateAuthFileDerivedCaches(invalidateModels, names, sourceScope.quotaStore),
    [invalidateModels, sourceScope.quotaStore]
  );
  // Names that leave the inventory (from any tab, the poll or a local delete) clear this
  // source's model and quota caches in the same step that publishes the new file list.
  useEffect(
    () =>
      useCredentialInventoryStore.getState().registerInvalidator((owner, names) => {
        if (sourceOwnerKey(owner) === sourceOwnerKey(sourceScope.session.owner)) {
          invalidateDerivedCaches(names);
        }
      }),
    [invalidateDerivedCaches, sourceScope.session.owner]
  );

  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    refreshing,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    manualRefreshing,
    refreshingAllCredentials,
    refreshResults,
    closeRefreshResults,
    handleRefreshAllCredentials,
    cooldownResetting,
    batchStatusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleManualRefresh,
    handleCooldownReset,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
  } = useAuthFilesData({ onFilesMutated: invalidateDerivedCaches });

  const statusBarCache = useAuthFilesStatusBarCache(files);

  // Only the provider lists and alias counts are needed here; edits happen on the Models screen.
  const { excluded, excludedError, modelAlias, loadExcluded, loadModelAlias } = useAuthFilesOauth({
    viewMode: 'list',
    files,
  });

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls: !sourceScope.isCurrent() || refreshingAllCredentials,
    loadFiles,
    onFilesMutated: invalidateDerivedCaches,
  });

  const disableControls = !sourceScope.isCurrent() || refreshingAllCredentials;
  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    filters.provider as QuotaProviderType
  )
    ? (filters.provider as QuotaProviderType)
    : null;
  const activeQuotaFilter: AuthFileQuotaFilter =
    filters.provider === 'all' ? 'all' : (quotaFilterType ?? filters.provider) || null;

  /* ---------- answered once / unreachable, reported to the page header ---------- */

  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (!loading) setAnswered(true);
  }, [loading]);
  const instanceId = sourceScope.source.instanceId;
  const answer: AnswerState = !answered ? 'loading' : error ? 'error' : 'ready';
  useEffect(() => onAnswer?.(instanceId, answer), [answer, instanceId, onAnswer]);
  // An unreachable hub takes no header actions; its banner offers "Try again" instead.
  const sourceDown = Boolean(error);
  const groupActionsDisabled = disableControls || sourceDown || !answered;
  useEffect(
    () => registerUpload?.(instanceId, handleUploadClick),
    [handleUploadClick, instanceId, registerUpload]
  );

  /* ---------- loading: foreground the first time (skeletons), background afterwards ---------- */

  const initialLoadDoneRef = useRef(false);
  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles({ background: true }), loadExcluded(), loadModelAlias()]);
  }, [loadFiles, loadExcluded, loadModelAlias]);

  useEffect(
    () => registerRefresh(sourceOwnerKey(sourceScope.session.owner), handleHeaderRefresh),
    [registerRefresh, sourceScope.session.owner, handleHeaderRefresh]
  );

  useEffect(() => {
    if (!isCurrentLayer) return;
    void loadFiles(initialLoadDoneRef.current ? { background: true } : undefined);
    initialLoadDoneRef.current = true;
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void loadFiles({ background: true }).catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  /* ---------- filter / sort / group / paginate ---------- */

  // Batch actions act on what is selected: a filter change clears it, so nothing hidden is hit.
  const filterKey = [filters.provider, filters.statusFilterMode, filters.search, hidden].join('\n');
  useEffect(() => deselectAll(), [filterKey, deselectAll]);

  const sorted = useMemo(
    () => groupByProvider(sortAuthFiles(filterAuthFiles(files, filters), filters.sortMode)),
    [files, filters]
  );
  const deleteTargets = useMemo(() => deletableShown(files, filters), [files, filters]);
  const pageSize = filters.pageSize;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = useMemo(() => sorted.slice(start, start + pageSize), [pageSize, sorted, start]);
  const pageGroups = useMemo(() => {
    const groups: Array<{ provider: string; items: AuthFileItem[] }> = [];
    pageItems.forEach((file) => {
      const key = providerGroupOf(file);
      const last = groups[groups.length - 1];
      if (last && last.provider === key) last.items.push(file);
      else groups.push({ provider: key, items: [file] });
    });
    return groups;
  }, [pageItems]);
  const providerTotals = useMemo(() => {
    const counts: Record<string, number> = {};
    sorted.forEach((file) => {
      const key = providerGroupOf(file);
      counts[key] = (counts[key] ?? 0) + 1;
    });
    return counts;
  }, [sorted]);
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectableFilteredItems = useMemo(
    () => sorted.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [sorted]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const selectedHasStatusUpdating = useMemo(
    () =>
      files.some(
        (file) =>
          selectedFiles.has(file.name) && statusUpdating[getAuthFileRefreshKey(file)] === true
      ),
    [files, selectedFiles, statusUpdating]
  );
  const batchStatusButtonsDisabled =
    disableControls ||
    selectedNames.length === 0 ||
    batchStatusUpdating ||
    selectedHasStatusUpdating;

  const groupCounts = useMemo(() => countCredentials(files), [files]);

  /* ---------- one-time card entrance cascade (see AuthFileCard) ---------- */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && isCurrentLayer && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) setCardsAnimated(true);
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const listState = listLoadState({ loading, refreshing, error, fileCount: files.length });
  const isFirstRunEmpty = listState === 'empty';
  const isNoResults = !loading && files.length > 0 && pageItems.length === 0;
  const linkState = { fromAuthFiles: true, sourceOwner: sourceScope.session.owner };

  const gridClasses = [
    styles.grid,
    filters.compactMode ? styles.gridCompact : '',
    activeQuotaFilter ? styles.gridQuota : '',
  ]
    .filter(Boolean)
    .join(' ');

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".json,application/json"
      multiple
      style={{ display: 'none' }}
      onChange={handleFileChange}
    />
  );

  // The page shows one empty state for every source: this group keeps only its upload input.
  if (pageEmpty) {
    return (
      <div
        className={styles.sourceGroup}
        data-machine="auth-files-list"
        data-state={listState}
        hidden
      >
        {fileInput}
      </div>
    );
  }

  const providerHeading = (provider: string, shownOnPage: number) => {
    const named = provider !== OTHER_PROVIDER_GROUP;
    const rules = excluded[provider]?.length ?? 0;
    const aliases = modelAlias[provider]?.length ?? 0;
    const label = getTypeLabel(t, provider);
    return (
      <div className={styles.providerHeader}>
        <h3 className={styles.providerHeading}>
          {t('auth_files.unified_provider_heading', {
            provider: label,
            count: providerTotals[provider] ?? shownOnPage,
          })}
        </h3>
        {/* Only stated once read: a failed or pending read shows nothing rather than 0. */}
        {named && excludedError === null && (
          <span className={styles.providerFacts}>
            {[
              t('auth_files.provider_rules', { count: rules }),
              aliases > 0 ? t('auth_files.provider_aliases', { count: aliases }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {named && (
          <Link
            className={styles.providerLink}
            to={modelsScreenPath(instanceId, provider)}
            state={linkState}
            aria-label={t('auth_files.provider_models_link_aria', { provider: label })}
            aria-disabled={groupActionsDisabled || undefined}
            tabIndex={groupActionsDisabled ? -1 : undefined}
            onClick={(event) => {
              if (groupActionsDisabled) event.preventDefault();
            }}
          >
            {t('auth_files.provider_models_link')} <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>
    );
  };

  return (
    <div className={styles.sourceGroup} data-machine="auth-files-list" data-state={listState}>
      <header className={styles.groupHeader}>
        <div className={styles.groupTitle}>
          <h2 className={styles.sourceHeading}>
            {sourceScope.source.label} <code>{sourceScope.source.instanceId}</code>
          </h2>
          <p className={styles.groupMeta}>
            {!answered ? (
              <span role="status">{t('auth_files.summary_loading')}</span>
            ) : sourceDown && files.length === 0 ? (
              <span className={styles.groupProblem}>{t('auth_files.source_unreachable')}</span>
            ) : (
              <>
                <span>
                  {t('auth_files.unified_group_count', {
                    shown: sorted.length,
                    total: files.length,
                  })}
                </span>
                {healthParts(t, groupCounts).map((part, index) => (
                  <span
                    key={part}
                    className={
                      index === 1 && groupCounts.problem > 0 ? styles.groupProblem : undefined
                    }
                  >
                    {part}
                  </span>
                ))}
                {refreshing && <span role="status">{t('common.loading')}</span>}
              </>
            )}
          </p>
        </div>
        <div className={styles.groupActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshAllCredentials}
            loading={refreshingAllCredentials}
            disabled={groupActionsDisabled || Object.keys(manualRefreshing).length > 0}
            title={t('auth_files.refresh_all_button')}
            aria-label={t('auth_files.refresh_all_button')}
          >
            <IconRefreshCw size={14} aria-hidden="true" /> {t('auth_files.refresh_all_short')}
          </Button>
          {!isFirstRunEmpty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleUploadClick}
              loading={uploading}
              disabled={groupActionsDisabled || uploading}
            >
              <IconUpload size={14} aria-hidden="true" /> {t('auth_files.upload_button')}
            </Button>
          )}
          <GroupMenu
            label={t('auth_files.more_actions', { source: sourceScope.source.label })}
            items={[
              {
                key: 'delete-shown',
                label: t('auth_files.delete_shown_menu', { count: deleteTargets.length }),
                danger: true,
                disabled:
                  groupActionsDisabled || loading || deletingAll || deleteTargets.length === 0,
                run: () => handleDeleteAll(deleteTargets),
              },
            ]}
          />
        </div>
      </header>
      <AuthFileRefreshResults results={refreshResults} onClose={closeRefreshResults} />
      {fileInput}

      {error && (
        <div className={`${styles.errorBanner} ${styles.errorWithAction}`} role="alert">
          <span>{error}</span>
          <Button
            variant="secondary"
            size="sm"
            loading={loading || refreshing}
            disabled={loading || refreshing}
            onClick={() => void loadFiles(files.length > 0 ? { background: true } : undefined)}
          >
            {t('auth_files.retry')}
          </Button>
        </div>
      )}

      {loading ? (
        <div className={gridClasses} aria-hidden="true">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
            <Skeleton key={index} height={206} rounded={14} />
          ))}
        </div>
      ) : isFirstRunEmpty ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            title={t('auth_files.empty_title')}
            description={t('auth_files.empty_desc')}
            action={
              <div className={styles.emptyActions}>
                <Button
                  size="sm"
                  onClick={handleUploadClick}
                  disabled={disableControls || uploading}
                >
                  {t('auth_files.upload_button')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    navigate(`/oauth?source=${encodeURIComponent(instanceId)}`, {
                      state: { sourceOwner: sourceScope.session.owner },
                    })
                  }
                >
                  {t('auth_files.empty_oauth_link')}
                </Button>
              </div>
            }
          />
        </div>
      ) : isNoResults ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            title={t('auth_files.unified_group_filtered_out')}
            action={
              <Button variant="secondary" size="sm" onClick={onClearFilters}>
                {t('auth_files.no_results_clear')}
              </Button>
            }
          />
        </div>
      ) : (
        pageGroups.map((group) => {
          const offset = pageItems.indexOf(group.items[0]);
          return (
            <div key={group.provider} className={styles.providerGroup}>
              {providerHeading(group.provider, group.items.length)}
              <div className={gridClasses}>
                {group.items.map((file, index) => (
                  <AuthFileCard
                    key={getQuotaCacheKey(file)}
                    file={file}
                    compact={filters.compactMode}
                    selected={selectedFiles.has(file.name)}
                    resolvedTheme={resolvedTheme}
                    disableControls={disableControls}
                    deleting={deleting}
                    statusUpdating={statusUpdating}
                    manualRefreshing={manualRefreshing}
                    cooldownResetting={cooldownResetting}
                    quotaFilterType={activeQuotaFilter}
                    statusBarCache={statusBarCache}
                    entranceDelayMs={cardEntranceDelay(offset + index)}
                    onShowModels={showModels}
                    onDownload={handleDownload}
                    onManualRefresh={handleManualRefresh}
                    onCooldownReset={handleCooldownReset}
                    onOpenPrefixProxyEditor={openPrefixProxyEditor}
                    onDelete={handleDelete}
                    onToggleStatus={handleStatusToggle}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      {!loading && sorted.length > pageSize && (
        <div className={styles.pagination}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
          >
            {t('auth_files.pagination_prev')}
          </Button>
          <div className={styles.pageInfo}>
            {t('auth_files.pagination_info', {
              current: currentPage,
              total: totalPages,
              count: sorted.length,
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
          >
            {t('auth_files.pagination_next')}
          </Button>
        </div>
      )}

      <AuthFileModelsModal
        open={modelsModalOpen}
        file={modelsFile}
        onClose={closeModelsModal}
        onRetry={reloadModels}
        onCopyText={copyTextWithNotification}
      />

      <AuthFileDetailsSheet
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={copyTextWithNotification}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      <BatchActionBar
        inline
        sourceLabel={sourceScope.source.label}
        selectionCount={selectionCount}
        selectablePageCount={selectablePageItems.length}
        selectableFilteredCount={selectableFilteredItems.length}
        disableControls={disableControls}
        batchStatusDisabled={batchStatusButtonsDisabled}
        onSelectPage={() => selectAllVisible(pageItems)}
        onSelectFiltered={() => selectAllVisible(sorted)}
        onInvertPage={() => invertVisibleSelection(pageItems)}
        onDeselectAll={deselectAll}
        onDownload={() => void batchDownload(selectedNames)}
        onEnable={() => batchSetStatus(selectedNames, true)}
        onDisable={() => batchSetStatus(selectedNames, false)}
        onDelete={() => batchDelete(selectedNames)}
      />
    </div>
  );
}
