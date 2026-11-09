import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
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
  isProblemAuthFile,
  isRuntimeOnlyAuthFile,
  type AuthFileQuotaFilter,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileDetailsSheet } from '@/features/authFiles/components/AuthFileDetailsSheet';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { AuthFileRefreshResults } from '@/features/authFiles/components/AuthFileRefreshResults';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesToolbar } from '@/features/authFiles/components/AuthFilesToolbar';
import { BatchActionBar } from '@/features/authFiles/components/BatchActionBar';
import { ModelAccessSummary } from '@/features/authFiles/components/ModelAccessSummary';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { VaultPulse } from '@/features/authFiles/components/VaultPulse';
import { invalidateAuthFileDerivedCaches } from '@/features/authFiles/cacheInvalidation';
import { sortAuthFiles } from '@/features/authFiles/logic';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { useAuthFilesFilters } from '@/features/authFiles/hooks/useAuthFilesFilters';
import {
  filterAuthFiles,
  groupByProvider,
  listLoadState,
  matchesStatusFilter,
  providerOfAuthFile,
  type AuthFilesFilters,
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

  const filterState = useAuthFilesFilters(sources[0]?.source.instanceId);
  const { filters } = filterState;

  // One read of the shared credential store for the page-wide totals, chips and counts.
  const inventorySources = useCredentialInventoryStore((state) => state.sources);
  const filesBySource = useMemo(() => {
    const result: Record<string, AuthFileItem[]> = {};
    for (const view of sources) {
      if (!view.session) continue;
      result[view.source.instanceId] =
        selectSourceFiles({ sources: inventorySources }, view.session.owner) ?? [];
    }
    return result;
  }, [inventorySources, sources]);
  const inScope = (instanceId: string) =>
    filters.source === ALL_SOURCES || filters.source === instanceId;
  const allFiles = Object.values(filesBySource).flat();
  const scopedFiles = Object.entries(filesBySource)
    .filter(([instanceId]) => inScope(instanceId))
    .flatMap(([, files]) => files);
  const statusFiltered = scopedFiles.filter((file) =>
    matchesStatusFilter(file, filters.statusFilterMode)
  );
  const providerTypes = ['all', ...new Set(scopedFiles.map(providerOfAuthFile).filter(Boolean))];
  const providerCounts: Record<string, number> = { all: statusFiltered.length };
  statusFiltered.forEach((file) => {
    const key = providerOfAuthFile(file);
    if (key) providerCounts[key] = (providerCounts[key] ?? 0) + 1;
  });
  const sourceCounts: Record<string, number> = { [ALL_SOURCES]: allFiles.length };
  Object.entries(filesBySource).forEach(([instanceId, files]) => {
    sourceCounts[instanceId] = files.length;
  });

  const statusFilterOptions = useMemo(
    () =>
      [
        { value: 'all', label: t('auth_files.problem_filter_all') },
        { value: 'enabled', label: t('auth_files.problem_filter_enabled') },
        { value: 'disabled', label: t('auth_files.problem_filter_disabled') },
        { value: 'problem', label: t('auth_files.problem_filter_problem') },
      ] satisfies Array<{ value: AuthFilesStatusFilterMode; label: string }>,
    [t]
  );
  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('auth_files.sort_default') },
      { value: 'az', label: t('auth_files.sort_az') },
      { value: 'priority', label: t('auth_files.sort_priority') },
    ],
    [t]
  );

  const active = allFiles.filter((file) => file.disabled !== true).length;
  const problem = allFiles.filter(isProblemAuthFile).length;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>{t('auth_files.unified_title')}</h1>
        <p className={styles.pageSummary}>
          {t('auth_files.unified_summary', {
            total: allFiles.length,
            sources: sources.length,
            active,
            problem,
          })}
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
          active={filters.source}
          onChange={filterState.setSource}
        />
        <ProviderTabs
          types={providerTypes}
          counts={providerCounts}
          active={providerTypes.includes(filters.provider) ? filters.provider : 'all'}
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

      {sources.map((view) => (
        <AuthFilesSourcePanel
          key={view.source.instanceId}
          view={view}
          hidden={!inScope(view.source.instanceId)}
          filters={filters}
          onClearFilters={filterState.clear}
          registerRefresh={registerRefresh}
        />
      ))}
    </div>
  );
}

type RegisterRefresh = (key: string, refresh: () => Promise<void>) => () => void;

export function AuthFilesSourcePanel({
  view,
  hidden,
  filters,
  onClearFilters,
  registerRefresh,
}: {
  view: SourceView;
  hidden: boolean;
  filters: AuthFilesFilters;
  onClearFilters: () => void;
  registerRefresh: RegisterRefresh;
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
            filters={filters}
            onClearFilters={onClearFilters}
            registerRefresh={registerRefresh}
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

function AuthFilesSourceContent({
  filters,
  onClearFilters,
  registerRefresh,
}: {
  filters: AuthFilesFilters;
  onClearFilters: () => void;
  registerRefresh: RegisterRefresh;
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
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
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
  const problemOnly = filters.statusFilterMode === 'problem';
  const disabledOnly = filters.statusFilterMode === 'disabled';
  const enabledOnly = filters.statusFilterMode === 'enabled';

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

  const sorted = useMemo(
    () => groupByProvider(sortAuthFiles(filterAuthFiles(files, filters), filters.sortMode)),
    [files, filters]
  );
  const pageSize = filters.pageSize;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = useMemo(() => sorted.slice(start, start + pageSize), [pageSize, sorted, start]);
  const pageGroups = useMemo(() => {
    const groups: Array<{ provider: string; items: AuthFileItem[] }> = [];
    pageItems.forEach((file) => {
      const key = providerOfAuthFile(file);
      const last = groups[groups.length - 1];
      if (last && last.provider === key) last.items.push(file);
      else groups.push({ provider: key, items: [file] });
    });
    return groups;
  }, [pageItems]);
  const providerTotals = useMemo(() => {
    const counts: Record<string, number> = {};
    sorted.forEach((file) => {
      const key = providerOfAuthFile(file);
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

  const activeCount = useMemo(() => files.filter((file) => file.disabled !== true).length, [files]);
  const problemCount = useMemo(() => files.filter(isProblemAuthFile).length, [files]);
  const sourceProviders = useMemo(
    () => [...new Set(files.map(providerOfAuthFile).filter((key) => key && key !== 'unknown'))],
    [files]
  );

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

  const openModels = useCallback(
    (provider?: string) => {
      sourceScope.assertCurrent();
      const params = new URLSearchParams({ source: sourceScope.source.instanceId });
      if (provider) params.set('provider', provider);
      navigate(`/auth-files/models?${params.toString()}`, {
        state: { fromAuthFiles: true, sourceOwner: sourceScope.session.owner },
      });
    },
    [navigate, sourceScope]
  );

  const deleteAllButtonLabel = (() => {
    if (enabledOnly || disabledOnly) return t('auth_files.delete_filtered_result_button');
    if (problemOnly) {
      return filters.provider === 'all'
        ? t('auth_files.delete_problem_button')
        : t('auth_files.delete_problem_button_with_type', {
            type: getTypeLabel(t, filters.provider),
          });
    }
    return filters.provider === 'all'
      ? t('auth_files.delete_all_button')
      : `${t('common.delete')} ${getTypeLabel(t, filters.provider)}`;
  })();

  const listState = listLoadState({ loading, refreshing, error, fileCount: files.length });
  const isFirstRunEmpty = listState === 'empty';
  const isNoResults = !loading && files.length > 0 && pageItems.length === 0;

  const gridClasses = [
    styles.grid,
    filters.compactMode ? styles.gridCompact : '',
    activeQuotaFilter ? styles.gridQuota : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.sourceGroup} data-machine="auth-files-list" data-state={listState}>
      <header className={styles.groupHeader}>
        <div className={styles.groupTitle}>
          <h2 className={styles.sourceHeading}>
            {sourceScope.source.label} <code>{sourceScope.source.instanceId}</code>
          </h2>
          <p className={styles.groupMeta}>
            <span>
              {t('auth_files.unified_group_count', { shown: sorted.length, total: files.length })}
            </span>
            <span>{t('auth_files.meta_active', { count: activeCount })}</span>
            {problemCount > 0 && (
              <span className={styles.groupProblem}>
                {t('auth_files.meta_problem', { count: problemCount })}
              </span>
            )}
            {refreshing && <span role="status">{t('common.loading')}</span>}
          </p>
        </div>
        <div className={styles.groupActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openModels()}
            aria-label={t('auth_files.unified_models_link_aria', {
              source: sourceScope.source.label,
            })}
          >
            {t('auth_files.unified_models_link')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshAllCredentials}
            loading={refreshingAllCredentials}
            disabled={disableControls || Object.keys(manualRefreshing).length > 0}
          >
            <IconRefreshCw size={14} aria-hidden="true" /> {t('auth_files.refresh_all_button')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleUploadClick}
            loading={uploading}
            disabled={disableControls || uploading}
          >
            <IconUpload size={14} aria-hidden="true" /> {t('auth_files.upload_button')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={styles.groupDelete}
            disabled={disableControls || loading || deletingAll || files.length === 0}
            loading={deletingAll}
            onClick={() =>
              handleDeleteAll({
                filter: filters.provider,
                problemOnly,
                disabledOnly,
                enabledOnly,
                // The page owns the filters; they stay as they are after a delete.
                onResetFilterToAll: () => {},
                onResetProblemOnly: () => {},
                onResetDisabledOnly: () => {},
                onResetEnabledOnly: () => {},
              })
            }
          >
            <IconTrash2 size={14} aria-hidden="true" /> {deleteAllButtonLabel}
          </Button>
        </div>
      </header>
      <AuthFileRefreshResults results={refreshResults} onClose={closeRefreshResults} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <VaultPulse files={files} statusBarCache={statusBarCache} />

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className={gridClasses} aria-hidden="true">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
            <Skeleton key={index} height={206} rounded={14} />
          ))}
        </div>
      ) : isFirstRunEmpty ? (
        <EmptyState
          title={t('auth_files.empty_title')}
          description={t('auth_files.empty_desc')}
          action={
            <div className={styles.emptyActions}>
              <Button size="sm" onClick={handleUploadClick} disabled={disableControls || uploading}>
                {t('auth_files.upload_button')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  navigate(`/oauth?source=${encodeURIComponent(sourceScope.source.instanceId)}`, {
                    state: { sourceOwner: sourceScope.session.owner },
                  })
                }
              >
                {t('auth_files.empty_oauth_link')}
              </Button>
            </div>
          }
        />
      ) : isNoResults ? (
        <EmptyState
          title={t('auth_files.unified_group_filtered_out')}
          action={
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              {t('auth_files.no_results_clear')}
            </Button>
          }
        />
      ) : (
        pageGroups.map((group) => {
          const offset = pageItems.indexOf(group.items[0]);
          return (
            <div key={group.provider} className={styles.providerGroup}>
              {filters.provider === 'all' && (
                <h3 className={styles.providerHeading}>
                  {t('auth_files.unified_provider_heading', {
                    provider: getTypeLabel(t, group.provider),
                    count: providerTotals[group.provider] ?? group.items.length,
                  })}
                </h3>
              )}
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

      <ModelAccessSummary
        providers={sourceProviders}
        excluded={excluded}
        excludedError={excludedError}
        modelAlias={modelAlias}
        onRetry={loadExcluded}
        onOpen={openModels}
      />

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
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
