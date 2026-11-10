import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconSearch } from '@/components/ui/icons';
import { useAuthFilesSource } from '@/features/authFiles/AuthFilesSourceContext';
import { getTypeLabel } from '@/features/authFiles/constants';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { isNamedProvider, providerOfCredential } from '@/features/authFiles/credentialFacts';
import { AuthFilesSourceNav } from '@/features/authFiles/components/AuthFilesSourceNav';
import toolbarStyles from '@/features/authFiles/components/AuthFilesToolbar.module.scss';
import { useModelAccessInventory } from '@/features/authFiles/hooks/useModelAccessInventory';
import { useModelEditSession } from '@/features/authFiles/hooks/useModelEditSession';
import { buildMatrix, inventoryOf, type ListTarget } from '@/features/authFiles/modelAccess';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
  useSourceFiles,
} from '@/stores/useCredentialInventoryStore';
import { useProviderSources } from '@/stores/useProviderSources';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { ModelAccessLegend, ModelAccessMatrix, type LockedCellInfo } from './ModelAccessMatrix';
import { LockedCellDialog, ModelEditDialog } from './ModelEditDialog';
import { ModelAliasesPanel } from './ModelAliasesPanel';
import { ModelRulesPanel } from './ModelRulesPanel';
import {
  countServed,
  filterAccounts,
  filterRows,
  isModelsTab,
  listKeyOf,
  MODEL_VIEWS,
  MODELS_TABS,
  resolveListKey,
  resolveProviderParam,
  type ModelView,
  type ModelsTab,
} from './matrixView';
import styles from './ModelsPage.module.scss';

/** Same breakpoint as the page's SCSS: under 600 px the matrix becomes a per-account list. */
const PHONE_QUERY = '(max-width: 599px)';

/** `#/auth-files/models?source=<id>&provider=<key>&tab=access|rules|aliases&list=<key>` */
export function ModelsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const scope = useAuthFilesSource();
  const [params, setParams] = useSearchParams();
  const files = useSourceFiles(scope.session.owner);
  const isPhone = useMediaQuery(PHONE_QUERY);

  // Every source with its credential count; a count appears once that source has been read.
  const { sources } = useProviderSources();
  const inventorySources = useCredentialInventoryStore((state) => state.sources);
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const view of sources) {
      if (!view.session) continue;
      const list = selectSourceFiles({ sources: inventorySources }, view.session.owner);
      if (list) counts[view.source.instanceId] = list.length;
    }
    return counts;
  }, [inventorySources, sources]);

  // undefined while this source's credentials are still unknown.
  const providerCounts = useMemo(() => {
    if (!files) return undefined;
    const counts: Record<string, number> = {};
    files.forEach((file) => {
      const key = providerOfCredential(file);
      if (isNamedProvider(key)) counts[key] = (counts[key] ?? 0) + 1;
    });
    return counts;
  }, [files]);
  const providers = useMemo(
    () => (providerCounts ? Object.keys(providerCounts).sort() : undefined),
    [providerCounts]
  );
  const requestedProvider = params.get('provider');
  const { provider, param: providerParam } = resolveProviderParam(requestedProvider, providers);
  const tab: ModelsTab = isModelsTab(params.get('tab'))
    ? (params.get('tab') as ModelsTab)
    : 'access';
  const requestedList = params.get('list');

  const setParam = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          Object.entries(changes).forEach(([key, value]) =>
            value === null ? next.delete(key) : next.set(key, value)
          );
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  // The URL names the provider shown: `grok` becomes `xai`, and a provider this source has no
  // credentials for (after switching hub, say) is replaced, with its account list link dropped.
  useEffect(() => {
    if (requestedProvider === providerParam) return;
    const sameProvider =
      requestedProvider !== null && normalizeOAuthProviderKey(requestedProvider) === providerParam;
    setParam(sameProvider ? { provider: providerParam } : { provider: providerParam, list: null });
  }, [providerParam, requestedProvider, setParam]);

  const { load, reload, io } = useModelAccessInventory(provider);
  const inventory = inventoryOf(load);
  const onChanged = useCallback(() => {
    void notifyAuthFilesChanged(scope.session.owner);
  }, [scope.session.owner]);
  const edit = useModelEditSession(inventory, io, reload, onChanged);
  const [locked, setLocked] = useState<LockedCellInfo | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [accountQuery, setAccountQuery] = useState('');
  const [view, setView] = useState<ModelView>('all');
  const [overflowing, setOverflowing] = useState(false);

  // The top bar's refresh re-lists the credentials and re-reads this provider's model access.
  const refresh = useCallback(async () => {
    if (provider) await reload({ credentials: true });
  }, [provider, reload]);
  useHeaderRefresh(refresh);

  // A link to an account list that no longer exists opens the provider list instead.
  const listKey = inventory
    ? resolveListKey(requestedList, inventory.accounts)
    : (requestedList ?? 'provider');
  useEffect(() => {
    if (inventory && requestedList !== null && requestedList !== listKey) setParam({ list: null });
  }, [inventory, listKey, requestedList, setParam]);

  // A provider switch clears filters that named the previous provider's models.
  useEffect(() => {
    setModelQuery('');
    setAccountQuery('');
  }, [provider]);

  const rows = useMemo(() => (inventory ? buildMatrix(inventory) : []), [inventory]);
  const visibleRows = useMemo(() => filterRows(rows, modelQuery, view), [rows, modelQuery, view]);
  const visibleAccounts = useMemo(
    () => (inventory ? filterAccounts(inventory.accounts, accountQuery) : []),
    [inventory, accountQuery]
  );
  const counts = countServed(visibleRows);
  const unreadable =
    inventory?.accounts.filter(
      (account) => account.kind === 'file' && account.ownList.status !== 'known'
    ) ?? [];
  const busy =
    edit.session.status !== 'idle' || load.status === 'refreshing' || load.status === 'loading';

  const openRules = (target: ListTarget) => setParam({ tab: 'rules', list: listKeyOf(target) });
  const goToRule = (info: LockedCellInfo) => {
    setLocked(null);
    openRules(
      info.list === 'provider' || !info.accountName
        ? { kind: 'provider' }
        : { kind: 'account', name: info.accountName }
    );
  };

  const onSourceChange = (instanceId: string) => {
    if (instanceId === scope.source.instanceId) return;
    const next = new URLSearchParams(params);
    next.set('source', instanceId);
    next.delete('provider');
    next.delete('list');
    navigate(`/auth-files/models?${next.toString()}`);
  };

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
          <span aria-hidden="true"> / </span>
          {scope.source.label}
        </p>
        <h1>{t('model_access.title')}</h1>
        <p className={styles.subtitle}>{t('model_access.subtitle')}</p>
      </div>
      <AuthFilesSourceNav
        sources={sources}
        counts={sourceCounts}
        active={scope.source.instanceId}
        onChange={onSourceChange}
        showAll={false}
      />
    </header>
  );

  const pickers = (
    <div className={styles.pickers}>
      <div className={styles.pickerField}>
        <span id="models-provider-label">{t('model_access.provider_label')}</span>
        <div
          className={styles.chips}
          role="group"
          aria-labelledby="models-provider-label"
          aria-busy={providerCounts === undefined}
        >
          {providerCounts === undefined ? (
            <>
              <span className={styles.srOnly}>{t('model_access.providers_loading')}</span>
              {[88, 72, 96].map((width) => (
                <Skeleton key={width} width={width} height={34} rounded={999} />
              ))}
            </>
          ) : (
            (providers ?? []).map((key) => (
              <button
                key={key}
                type="button"
                className={styles.chip}
                aria-pressed={key === provider}
                onClick={() => setParam({ provider: key, list: null })}
              >
                {getTypeLabel(t, key)}
                <span className={styles.chipCount}>{providerCounts[key]}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const tabs = (
    <div className={styles.tabs} role="tablist" aria-label={t('model_access.tabs_label')}>
      {MODELS_TABS.map((key, index) => (
        <button
          key={key}
          id={`models-tab-${key}`}
          type="button"
          role="tab"
          aria-selected={tab === key}
          aria-controls={`models-panel-${key}`}
          tabIndex={tab === key ? 0 : -1}
          className={styles.tab}
          onClick={() => setParam({ tab: key })}
          onKeyDown={(event) => onTabKey(event, index)}
        >
          {t(`model_access.tab_${key}`)}
        </button>
      ))}
    </div>
  );

  const loadingState = (
    <div className={styles.skeletons} aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} height={40} rounded={8} />
      ))}
    </div>
  );

  const renderAccess = () => {
    if (!inventory) return null;
    if (inventory.accounts.length === 0) {
      return (
        <EmptyState
          title={t('model_access.empty_title')}
          description={t('model_access.empty_desc')}
          action={
            <Button size="sm" variant="secondary" onClick={() => navigate('/auth-files')}>
              {t('nav.auth_files')}
            </Button>
          }
        />
      );
    }
    return (
      <>
        <div className={`${toolbarStyles.toolbar} ${styles.filterBar}`}>
          <div className={toolbarStyles.search}>
            <Input
              value={modelQuery}
              onChange={(event) => setModelQuery(event.currentTarget.value)}
              placeholder={t('model_access.filter_models')}
              aria-label={t('model_access.filter_models')}
              rightElement={<IconSearch className={toolbarStyles.searchIcon} size={16} />}
            />
          </div>
          <div className={toolbarStyles.search}>
            <Input
              value={accountQuery}
              onChange={(event) => setAccountQuery(event.currentTarget.value)}
              placeholder={t('model_access.filter_accounts')}
              aria-label={t('model_access.filter_accounts')}
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
                onClick={() => setView(key)}
              >
                {t(`model_access.view_${key}`)}
              </button>
            ))}
          </div>
          <span className={styles.counts} aria-live="polite">
            {t('model_access.counts', {
              shown: visibleRows.length,
              served: counts.served,
              total: counts.total,
            })}
            {overflowing && !isPhone && (
              <span className={styles.scrollNote}>
                {t('model_access.accounts_scroll', { count: visibleAccounts.length })}
              </span>
            )}
          </span>
        </div>
        {inventory.catalog.length === 0 && (
          <p className={styles.banner} data-tone="info">
            {t('model_access.catalog_unavailable')}
          </p>
        )}
        {unreadable.length > 0 && (
          <p className={styles.banner} data-tone="danger" role="alert">
            {t('model_access.unreadable_accounts', {
              accounts: unreadable.map((account) => account.label).join(', '),
            })}
          </p>
        )}
        {visibleRows.length === 0 || visibleAccounts.length === 0 ? (
          <EmptyState
            title={t('model_access.no_rows')}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setModelQuery('');
                  setAccountQuery('');
                  setView('all');
                }}
              >
                {t('model_access.clear_filters')}
              </Button>
            }
          />
        ) : (
          <>
            <ModelAccessLegend />
            <ModelAccessMatrix
              provider={getTypeLabel(t, provider)}
              rows={visibleRows}
              accounts={visibleAccounts}
              disabled={busy}
              layout={isPhone ? 'list' : 'table'}
              onToggleCell={(account, model, exclude) =>
                edit.start({ type: 'account-model', account: account.name, model, exclude })
              }
              onLockedCell={setLocked}
              onEverywhere={(model, exclude) =>
                edit.start({ type: 'model-everywhere', model, exclude })
              }
              onProviderDefault={(model, exclude) =>
                edit.start({ type: 'provider-model', model, exclude })
              }
              onAccountAll={(account, exclude) =>
                edit.start({ type: 'account-all', account: account.name, exclude })
              }
              onEditRule={openRules}
              onOverflowChange={setOverflowing}
            />
            <p className={styles.matrixNote}>
              {t('model_access.api_keys_note')}{' '}
              <Link to="/ai-providers">{t('nav.ai_providers')}</Link>
            </p>
          </>
        )}
      </>
    );
  };

  let content: React.ReactNode;
  if (!provider) {
    content =
      files === undefined ? (
        loadingState
      ) : (
        <EmptyState
          title={t('model_access.no_provider')}
          description={t('model_access.empty_desc')}
        />
      );
  } else if (load.status === 'idle' || load.status === 'loading') {
    content = (
      <>
        <p role="status" className={styles.srOnly}>
          {t('model_access.loading')}
        </p>
        {loadingState}
      </>
    );
  } else if (load.status === 'error' && !inventory) {
    content = (
      <EmptyState
        title={t('model_access.error_title')}
        description={load.message}
        action={
          <Button size="sm" variant="secondary" onClick={() => void reload({ credentials: true })}>
            {t('model_access.retry_load')}
          </Button>
        }
      />
    );
  } else if (tab === 'access') {
    content = renderAccess();
  } else if (tab === 'rules' && inventory) {
    content = (
      <ModelRulesPanel
        inventory={inventory}
        listKey={listKey}
        onListKeyChange={(key) => setParam({ list: key })}
        disabled={busy}
        onReview={(target, rules) => edit.start({ type: 'replace-list', target, rules })}
      />
    );
  } else {
    content = <ModelAliasesPanel provider={provider} disabled={busy} />;
  }

  return (
    <div className={styles.page}>
      {header}
      {pickers}
      {tabs}
      <section
        id={`models-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`models-tab-${tab}`}
        className={styles.panel}
        data-machine="model-inventory"
        data-state={load.status}
      >
        {load.status === 'error' && inventory && (
          <p className={styles.banner} data-tone="danger" role="alert">
            {t('model_access.refresh_failed', { message: load.message })}
          </p>
        )}
        {content}
      </section>
      <p
        className={styles.srOnly}
        role="status"
        data-testid="edit-session"
        data-machine="model-edit-session"
        data-state={edit.session.status}
      >
        {edit.session.status === 'idle'
          ? ''
          : t(`model_access.session_${edit.session.status.replace('-', '_')}`)}
      </p>
      <ModelEditDialog
        session={edit.session}
        inventory={inventory}
        onChoose={edit.choose}
        onApply={() => void edit.apply()}
        onRetry={() => void edit.retry()}
        onRollback={() => void edit.rollback()}
        onReplan={() => void edit.replan()}
        onClose={edit.close}
      />
      <LockedCellDialog info={locked} onClose={() => setLocked(null)} onEditRule={goToRule} />
    </div>
  );
}
