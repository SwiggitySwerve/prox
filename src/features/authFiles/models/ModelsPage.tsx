import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { IconSearch } from '@/components/ui/icons';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { AuthFilesSourceProvider } from '@/features/authFiles/AuthFilesSourceContext';
import type { ResolvedTheme } from '@/features/authFiles/constants';
import {
  ALL_SOURCES,
  AuthFilesSourceNav,
} from '@/features/authFiles/components/AuthFilesSourceNav';
import toolbarStyles from '@/features/authFiles/components/AuthFilesToolbar.module.scss';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { useHeaderRefresh, type HeaderRefreshRound } from '@/hooks/useHeaderRefresh';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useThemeStore } from '@/stores';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
} from '@/stores/useCredentialInventoryStore';
import { useProviderSources } from '@/stores/useProviderSources';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import {
  HubHeading,
  ModelsHubSection,
  SectionSkeleton,
  SectionState,
  type SetModelsParam,
} from './ModelsHubSection';
import {
  hubsForProvider,
  isModelsTab,
  listOwner,
  MODEL_VIEWS,
  MODELS_TABS,
  providerCountsAcross,
  resolveProviderAcross,
  resolveProviderParam,
  resolveSourceScope,
  sumCounts,
  targetOfListKey,
  type HubFiles,
  type ModelView,
  type ModelsTab,
  type VisibleCounts,
} from './matrixView';
import styles from './ModelsPage.module.scss';

/** Same breakpoint as the page's SCSS: under 600 px the table becomes a per-account list. */
const PHONE_QUERY = '(max-width: 599px)';

/**
 * The page's width cap for a grid of `columns` accounts: the model column and account columns at
 * their widest (ModelsPage.module.scss --head-max, --account-max, the frame's border), never
 * narrower than the toolbar needs on one row. Without a grid, no cap.
 */
const pageMaxWidth = (columns: number) =>
  columns > 0 ? `${Math.max(1100, 336 + columns * 200 + 2)}px` : undefined;

/**
 * `#/auth-files/models?source=<id>&provider=<key>&tab=access|rules|aliases&list=<key>`
 *
 * One provider at a time (the provider tabs), across every hub (or the one `?source=` names): one
 * section per hub that has credentials of that provider, each in its own hub scope.
 */
export function ModelsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const registry = useProviderSources();
  const { sources } = registry;
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const inventorySources = useCredentialInventoryStore((state) => state.sources);
  const storeStatus = useCredentialInventoryStore((state) => state.status);

  const setParam = useCallback<SetModelsParam>(
    (changes) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          Object.entries(changes).forEach(([key, value]) =>
            value === null ? next.delete(key) : next.set(key, value)
          );
          // `listHub` says which hub `list` belongs to; it goes when the list goes.
          if (changes.list === null) next.delete('listHub');
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  // The top bar's refresh. Its round already re-lists every hub once and re-reads every loaded
  // model list (useModelAccessStore.refreshLoaded); the sections read those slices, and accounts
  // the new list adds load through the sections' own effects. Without a round, reload each section.
  const refreshers = useRef(new Map<string, () => Promise<void>>());
  const registerRefresh = useCallback((key: string, run: () => Promise<void>) => {
    refreshers.current.set(key, run);
    return () => {
      if (refreshers.current.get(key) === run) refreshers.current.delete(key);
    };
  }, []);
  const refresh = useCallback(async (round?: HeaderRefreshRound) => {
    if (round) {
      await round.inventory;
      return;
    }
    if (refreshers.current.size === 0) {
      await useCredentialInventoryStore.getState().refresh();
      return;
    }
    await Promise.allSettled([...refreshers.current.values()].map((run) => run()));
  }, []);
  useHeaderRefresh(refresh);

  // The Save bars dock at the bottom of the viewport, over this page's column. The app shell clips
  // the page (overflow: hidden), so a sticky bar inside it never sticks; the dock lives on <body>.
  const pageRef = useRef<HTMLDivElement>(null);
  // Only the visible route docks: a previous route's layer stays mounted (hidden) for a while.
  const isCurrentLayer = usePageTransitionLayer()?.isCurrentLayer ?? true;
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = useState(0);
  useEffect(() => {
    const page = pageRef.current;
    if (!page || !dock) return;
    const place = () => {
      const box = page.getBoundingClientRect();
      dock.style.setProperty('--dock-left', `${box.left}px`);
      dock.style.setProperty('--dock-width', `${box.width}px`);
      setDockHeight(dock.offsetHeight);
      // The page reserves the bar's height at its end; when the content ends above the fold the
      // bar sits right under it instead of over the last lines at the bottom of the screen.
      const contentEnd = box.bottom - (parseFloat(getComputedStyle(page).paddingBottom) || 0);
      const below = window.innerHeight - contentEnd - dock.offsetHeight;
      dock.style.setProperty('--dock-bottom', `${Math.max(0, below)}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(page);
    observer?.observe(dock);
    window.addEventListener('resize', place);
    // The shell scrolls inside an element: catch its scroll on the way down.
    window.addEventListener('scroll', place, { capture: true, passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, { capture: true });
    };
  }, [dock]);

  // The grid's account header sticks just under the filter bar (sticky itself, except on phones).
  const filterBarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const page = pageRef.current;
    const bar = filterBarRef.current;
    if (!page || !bar) return;
    const place = () => {
      const sticky = getComputedStyle(bar).position === 'sticky';
      page.style.setProperty('--models-sticky-top', `${sticky ? bar.offsetHeight : 0}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(bar);
    return () => observer?.disconnect();
  }, []);

  // The widest grid's account columns: the page is no wider than that grid needs.
  const [gridColumns, setGridColumns] = useState<Record<string, number>>({});
  const reportColumns = useCallback((key: string, columns: number | null) => {
    setGridColumns((prev) => {
      if ((prev[key] ?? null) === columns) return prev;
      const next = { ...prev };
      if (columns === null) delete next[key];
      else next[key] = columns;
      return next;
    });
  }, []);

  // What each section's table shows, summed for the counter.
  const [sectionCounts, setSectionCounts] = useState<Record<string, VisibleCounts>>({});
  const reportCounts = useCallback((key: string, counts: VisibleCounts | null) => {
    setSectionCounts((prev) => {
      const current = prev[key];
      if (!counts) {
        if (!current) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (
        current &&
        current.models === counts.models &&
        current.served === counts.served &&
        current.accounts === counts.accounts
      ) {
        return prev;
      }
      return { ...prev, [key]: counts };
    });
  }, []);

  // ---------- hubs in scope ----------
  const hubIds = sources.map((view) => view.source.instanceId);
  const sourceParam = params.get('source');
  const scope = resolveSourceScope(sourceParam, hubIds);
  const inScope = (instanceId: string) => scope === null || scope === instanceId;
  const scopedViews = sources.filter((view) => inScope(view.source.instanceId));
  const hubFiles: HubFiles[] = scopedViews.flatMap((view) =>
    view.status === 'ready' && view.session
      ? [
          {
            id: view.source.instanceId,
            files: selectSourceFiles({ sources: inventorySources }, view.session.owner),
          },
        ]
      : []
  );
  const multiHub = sources.length > 1;

  // Pill counts: a hub's count once it has been read; "All" once every hub has.
  const sourceCounts: Record<string, number> = {};
  let allKnown = true;
  let allTotal = 0;
  for (const view of sources) {
    const files =
      view.status === 'ready' && view.session
        ? selectSourceFiles({ sources: inventorySources }, view.session.owner)
        : undefined;
    if (files) {
      sourceCounts[view.source.instanceId] = files.length;
      allTotal += files.length;
    } else if (view.status === 'ready') {
      allKnown = false;
    }
  }
  if (allKnown && sources.length > 0) sourceCounts[ALL_SOURCES] = allTotal;

  // ---------- provider tab ----------
  const credentialsPending = storeStatus === 'idle' || storeStatus === 'loading';
  const { counts: providerCounts, complete } = providerCountsAcross(hubFiles);
  const providers = Object.keys(providerCounts).sort();
  const providersKnown =
    registry.status === 'ready' && (hubFiles.some((hub) => hub.files) || !credentialsPending);
  const requestedProvider = params.get('provider');
  const { provider, param: providerParam } = providersKnown
    ? resolveProviderAcross(requestedProvider, providers, complete)
    : resolveProviderParam(requestedProvider, undefined);
  const tabTypes = provider && !providers.includes(provider) ? [...providers, provider] : providers;

  const tab: ModelsTab = isModelsTab(params.get('tab'))
    ? (params.get('tab') as ModelsTab)
    : 'access';

  // The URL names the provider shown: `grok` becomes `xai`, and a provider no hub in scope has
  // credentials for (after switching hub, say) is replaced, with its account list link dropped.
  useEffect(() => {
    if (requestedProvider === providerParam) return;
    const sameProvider =
      requestedProvider !== null && normalizeOAuthProviderKey(requestedProvider) === providerParam;
    setParam(sameProvider ? { provider: providerParam } : { provider: providerParam, list: null });
  }, [providerParam, requestedProvider, setParam]);

  // ---------- Rules list link ----------
  const requestedList = params.get('list');
  const namedSource = sourceParam && hubIds.includes(sourceParam) ? sourceParam : null;
  const owner = listOwner(requestedList, namedSource, hubFiles, params.get('listHub'));
  const orphanList =
    complete &&
    requestedList !== null &&
    owner === null &&
    targetOfListKey(requestedList).kind === 'account';
  useEffect(() => {
    if (orphanList) setParam({ list: null });
  }, [orphanList, setParam]);

  // ---------- filters ----------
  const [modelQuery, setModelQuery] = useState('');
  const [accountQuery, setAccountQuery] = useState('');
  const [view, setView] = useState<ModelView>('all');
  const clearFilters = useCallback(() => {
    setModelQuery('');
    setAccountQuery('');
    setView('all');
  }, []);
  // A provider switch clears filters that named the previous provider's models.
  useEffect(() => {
    setModelQuery('');
    setAccountQuery('');
  }, [provider]);

  const sectionIds = providersKnown ? hubsForProvider(hubFiles, provider) : [];
  const shownCounts = sumCounts(
    Object.entries(sectionCounts)
      .filter(([key]) => sectionIds.includes(key))
      .map(([, counts]) => counts)
  );
  const hasCounts = tab === 'access' && sectionIds.some((key) => sectionCounts[key]);

  const onSourceChange = (instanceId: string) =>
    setParam({ source: instanceId === ALL_SOURCES ? null : instanceId, list: null });

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next =
      MODELS_TABS[
        (index + (event.key === 'ArrowRight' ? 1 : MODELS_TABS.length - 1)) % MODELS_TABS.length
      ];
    setParam({ tab: next });
    document.getElementById(`models-tab-${next}`)?.focus();
  };

  const header = (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <p className={styles.eyebrow}>
          <Link to="/auth-files">{t('nav.auth_files')}</Link>
        </p>
        <h1>{t('model_access.title')}</h1>
        <p className={styles.subtitle}>{t('model_access.subtitle')}</p>
      </div>
    </header>
  );

  // Nothing to filter (Rules, Aliases, or no grid yet): the filters stay in place, visibly off.
  const filtersOff = tab !== 'access' || !hasCounts;
  const filterBar = (
    <section
      ref={filterBarRef}
      className={styles.filterBar}
      aria-label={t('model_access.filters_label')}
    >
      <AuthFilesSourceNav
        sources={sources}
        counts={sourceCounts}
        active={scope ?? ALL_SOURCES}
        onChange={onSourceChange}
      />
      <div className={styles.providerStrip}>
        <ProviderTabs
          types={tabTypes}
          counts={complete ? providerCounts : null}
          active={provider}
          resolvedTheme={resolvedTheme}
          onChange={(key) => setParam({ provider: key, list: null })}
          ariaLabel={t('model_access.provider_label')}
          placeholders={providersKnown ? 0 : 3}
        />
        {!providersKnown && (
          <span className={styles.srOnly} role="status">
            {t('model_access.providers_loading')}
          </span>
        )}
      </div>
      <div className={`${toolbarStyles.toolbar} ${styles.controls}`}>
        <div
          className={toolbarStyles.segmented}
          role="tablist"
          aria-label={t('model_access.tabs_label')}
        >
          {MODELS_TABS.map((key, index) => (
            <button
              key={key}
              id={`models-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`models-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              className={`${toolbarStyles.segment} ${tab === key ? toolbarStyles.segmentActive : ''}`}
              onClick={() => setParam({ tab: key })}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {t(`model_access.tab_${key}`)}
            </button>
          ))}
        </div>
        <div className={`${toolbarStyles.search} ${styles.filterField}`}>
          <Input
            value={modelQuery}
            onChange={(event) => setModelQuery(event.currentTarget.value)}
            placeholder={t('model_access.filter_models')}
            aria-label={t('model_access.filter_models')}
            disabled={filtersOff}
            rightElement={<IconSearch className={toolbarStyles.searchIcon} size={16} />}
          />
        </div>
        <div className={`${toolbarStyles.search} ${styles.filterField}`}>
          <Input
            value={accountQuery}
            onChange={(event) => setAccountQuery(event.currentTarget.value)}
            placeholder={t('model_access.filter_accounts')}
            aria-label={t('model_access.filter_accounts')}
            disabled={filtersOff}
            rightElement={<IconSearch className={toolbarStyles.searchIcon} size={16} />}
          />
        </div>
        <div
          className={toolbarStyles.segmented}
          role="group"
          aria-label={t('model_access.view_label')}
        >
          {MODEL_VIEWS.map((key) => (
            <button
              key={key}
              type="button"
              className={`${toolbarStyles.segment} ${
                view === key ? toolbarStyles.segmentActive : ''
              }`}
              aria-pressed={view === key}
              data-testid={`models-view-${key}`}
              disabled={filtersOff}
              onClick={() => setView(key)}
            >
              {t(`model_access.view_${key}`)}
            </button>
          ))}
        </div>
        <span className={styles.counts} aria-live="polite">
          {hasCounts
            ? t('model_access.counts', {
                models: shownCounts.models,
                served: shownCounts.served,
                accounts: shownCounts.accounts,
              })
            : ''}
        </span>
      </div>
    </section>
  );

  const pageBlock = (() => {
    if (registry.status === 'loading' || (registry.status === 'ready' && !providersKnown)) {
      return (
        <SectionState kind="loading">
          <p role="status" className={styles.loadingNote}>
            {t('model_access.loading')}
          </p>
          <SectionSkeleton />
        </SectionState>
      );
    }
    if (registry.status !== 'ready') {
      return (
        <SectionState kind="error">
          <EmptyState title={t('provider_sources.discovery_error')} />
        </SectionState>
      );
    }
    if (provider) return null;
    if (!complete && hubFiles.length > 0) {
      // A hub's credentials could not be read, and no hub that was read has any provider.
      return (
        <SectionState kind="error">
          <EmptyState
            title={t('model_access.error_title')}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void useCredentialInventoryStore.getState().refresh()}
              >
                {t('model_access.retry_load')}
              </Button>
            }
          />
        </SectionState>
      );
    }
    if (hubFiles.length === 0 && scopedViews.length > 0) return null;
    return (
      <SectionState kind="empty">
        <EmptyState
          title={t('model_access.no_provider')}
          description={t('model_access.no_provider_desc')}
          action={
            <Button size="sm" variant="secondary" onClick={() => navigate('/auth-files')}>
              {t('model_access.open_auth_files')}
            </Button>
          }
        />
      </SectionState>
    );
  })();

  return (
    <div
      ref={pageRef}
      className={styles.page}
      style={
        {
          // Room under the last row, so the docked bars never cover it.
          paddingBottom: dockHeight > 0 ? dockHeight + 24 : undefined,
          '--models-max-width': pageMaxWidth(Math.max(0, ...Object.values(gridColumns))),
        } as CSSProperties
      }
    >
      {isCurrentLayer &&
        createPortal(<div ref={setDock} className={styles.saveDock} />, document.body)}
      {header}
      {filterBar}
      <div
        id={`models-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`models-tab-${tab}`}
        className={styles.panel}
      >
        {pageBlock}
        {registry.status === 'ready' &&
          scopedViews.map((hub) => {
            const id = hub.source.instanceId;
            if (hub.status !== 'ready' || !hub.session) {
              return (
                <section key={id} className={styles.hubSection} aria-label={hub.source.label}>
                  {multiHub && <HubHeading label={hub.source.label} id={id} />}
                  <SectionState kind="signed-out">
                    <EmptyState
                      title={
                        hub.status === 'unauthorized'
                          ? t('provider_sources.authentication_required')
                          : t('auth_files.source_authentication_required', {
                              defaultValue: 'Sign in to this source to view its auth files.',
                            })
                      }
                    />
                  </SectionState>
                </section>
              );
            }
            if (!sectionIds.includes(id)) return null;
            return (
              <section
                key={id}
                className={styles.hubSection}
                aria-label={hub.source.label}
                data-source-id={id}
              >
                <AuthFilesSourceProvider source={hub.source} session={hub.session}>
                  <ModelsHubSection
                    key={provider}
                    provider={provider}
                    tab={tab}
                    requestedList={owner === id ? requestedList : null}
                    showHeading={multiHub}
                    isPhone={isPhone}
                    modelQuery={modelQuery}
                    accountQuery={accountQuery}
                    view={view}
                    onClearFilters={clearFilters}
                    setParam={setParam}
                    registerRefresh={registerRefresh}
                    reportCounts={reportCounts}
                    reportColumns={reportColumns}
                    saveDock={dock}
                  />
                </AuthFilesSourceProvider>
              </section>
            );
          })}
      </div>
    </div>
  );
}
