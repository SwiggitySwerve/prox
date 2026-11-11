import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconAlertTriangle, IconEye } from '@/components/ui/icons';
import { useAuthFilesSource } from '@/features/authFiles/AuthFilesSourceContext';
import { getTypeLabel } from '@/features/authFiles/constants';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { useModelAccessInventory } from '@/features/authFiles/hooks/useModelAccessInventory';
import { useAccessDraft } from '@/features/authFiles/hooks/useAccessDraft';
import { useModelEditSession } from '@/features/authFiles/hooks/useModelEditSession';
import { buildMatrix, followsProviderList, inventoryOf } from '@/features/authFiles/modelAccess';
import { AccessSaveBar } from './AccessSaveBar';
import { AccessKey, ModelAccessMatrix } from './ModelAccessMatrix';
import {
  browserStorage,
  hiddenStorageKey,
  readHidden,
  withHidden,
  writeHidden,
} from './hiddenModels';
import { ModelEditDialog } from './ModelEditDialog';
import { ModelAliasesPanel } from './ModelAliasesPanel';
import { ModelRulesPanel } from './ModelRulesPanel';
import {
  countServed,
  filterAccounts,
  filterRows,
  resolveListKey,
  sortRowsNewestFirst,
  type ModelView,
  type ModelsTab,
  type VisibleCounts,
} from './matrixView';
import styles from './ModelsPage.module.scss';

export type SetModelsParam = (changes: Record<string, string | null>) => void;

type Props = {
  provider: string;
  tab: ModelsTab;
  /** `?list=` when it belongs to this hub (see listOwner), else null: the provider list. */
  requestedList: string | null;
  /** More than one hub exists: name this one above its table. */
  showHeading: boolean;
  isPhone: boolean;
  modelQuery: string;
  accountQuery: string;
  view: ModelView;
  onClearFilters: () => void;
  setParam: SetModelsParam;
  registerRefresh: (key: string, refresh: () => Promise<void>) => () => void;
  /** What this hub's access table shows, for the page counter; null when it shows no table. */
  reportCounts: (key: string, counts: VisibleCounts | null) => void;
  /** How many account columns this hub's grid has (unfiltered), for the page's width. */
  reportColumns: (key: string, columns: number | null) => void;
  /** Where the Save bar goes (fixed at the bottom of the viewport); inline until it exists. */
  saveDock: HTMLElement | null;
};

/** The block every non-table state of a section fills: same frame and height as the table. */
export function SectionState({
  kind,
  children,
}: {
  kind: 'loading' | 'empty' | 'error' | 'unsupported' | 'no-rows' | 'signed-out';
  children: ReactNode;
}) {
  return (
    <div className={styles.stateBlock} data-kind={kind}>
      {children}
    </div>
  );
}

/** Rows of placeholder bars in the table's shape, for a section whose models are loading. */
export function SectionSkeleton() {
  return (
    <div className={styles.skeletons} aria-hidden="true">
      <Skeleton height={72} rounded={8} />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} height={36} rounded={8} />
      ))}
    </div>
  );
}

/**
 * One hub's part of the Models screen for one provider: its own inventory, edit session and
 * dialogs, inside that hub's scope (AuthFilesSourceProvider). The page owns the filters and URL.
 */
export function ModelsHubSection({
  provider,
  tab,
  requestedList,
  showHeading,
  isPhone,
  modelQuery,
  accountQuery,
  view,
  onClearFilters,
  setParam,
  registerRefresh,
  reportCounts,
  reportColumns,
  saveDock,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const scope = useAuthFilesSource();
  const hubId = scope.source.instanceId;

  const { load, reload, io } = useModelAccessInventory(provider);
  const inventory = inventoryOf(load);
  const onChanged = useCallback(() => {
    void notifyAuthFilesChanged(scope.session.owner);
  }, [scope.session.owner]);
  const edit = useModelEditSession(inventory, io, reload, onChanged);
  const draft = useAccessDraft(inventory, io, reload, onChanged);
  const [overflowing, setOverflowing] = useState(false);

  // Models hidden from the bands: this browser's view of this hub and provider, never access.
  const hiddenKey = hiddenStorageKey(hubId, provider);
  const [hidden, setHidden] = useState(() => readHidden(browserStorage(), hiddenKey));
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  // The "N hidden" button is for when the Hidden band is out of sight; it steps aside otherwise.
  const [hiddenBandInView, setHiddenBandInView] = useState(false);
  useEffect(() => {
    const check = () => {
      const band = sectionRef.current?.querySelector('[data-section="hidden"]');
      const box = band?.getBoundingClientRect();
      setHiddenBandInView(Boolean(box && box.top < window.innerHeight && box.bottom > 0));
    };
    const frame = requestAnimationFrame(check);
    window.addEventListener('scroll', check, { capture: true, passive: true });
    window.addEventListener('resize', check);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', check, { capture: true });
      window.removeEventListener('resize', check);
    };
  });
  const setModelsHidden = useCallback(
    (models: string[], hide: boolean) =>
      setHidden((prev) => {
        const next = withHidden(prev, models, hide);
        writeHidden(browserStorage(), hiddenKey, next);
        return next;
      }),
    [hiddenKey]
  );

  // The top bar's refresh re-lists the credentials and re-reads this provider's model access.
  useEffect(
    () =>
      registerRefresh(hubId, async () => {
        await reload({ credentials: true });
      }),
    [hubId, registerRefresh, reload]
  );

  // A link to an account list that no longer exists opens the provider list instead.
  const listKey = inventory
    ? resolveListKey(requestedList, inventory.accounts)
    : (requestedList ?? 'provider');
  useEffect(() => {
    if (inventory && requestedList !== null && requestedList !== listKey) setParam({ list: null });
  }, [inventory, listKey, requestedList, setParam]);

  const rows = useMemo(
    () => (inventory ? sortRowsNewestFirst(buildMatrix(inventory)) : []),
    [inventory]
  );
  const visibleRows = useMemo(() => filterRows(rows, modelQuery, view), [rows, modelQuery, view]);
  const visibleAccounts = useMemo(
    () => (inventory ? filterAccounts(inventory.accounts, accountQuery) : []),
    [inventory, accountQuery]
  );
  const counts = countServed(visibleRows);
  const hiddenShown = modelQuery.trim()
    ? 0
    : visibleRows.filter((row) => hidden.has(row.model)).length;
  const showsTable = tab === 'access' && inventory !== null && inventory.accounts.length > 0;
  const models = showsTable ? visibleRows.length : 0;
  const served = showsTable ? counts.served : 0;
  const accounts = showsTable ? visibleAccounts.length : 0;
  useEffect(() => {
    reportCounts(hubId, showsTable ? { models, served, accounts } : null);
  }, [accounts, hubId, models, reportCounts, served, showsTable]);
  useEffect(() => () => reportCounts(hubId, null), [hubId, reportCounts]);
  const columns = inventory?.accounts.length ?? null;
  useEffect(() => reportColumns(hubId, columns), [columns, hubId, reportColumns]);
  useEffect(() => () => reportColumns(hubId, null), [hubId, reportColumns]);

  const unreadable =
    inventory?.accounts.filter(
      (account) => account.kind === 'file' && account.ownList.status !== 'known'
    ) ?? [];
  const saving = draft.save.status === 'saving';
  const busy =
    saving ||
    edit.session.status !== 'idle' ||
    load.status === 'refreshing' ||
    load.status === 'loading';

  // Accounts whose last Save did not land; the provider list's failure is every follower's.
  const failed = useMemo(() => {
    const map = new Map<string, string>();
    if (draft.save.status !== 'failed' || !inventory) return map;
    for (const failure of draft.save.failures) {
      if (failure.target.kind === 'account') {
        map.set(failure.target.name, failure.message);
        continue;
      }
      for (const account of inventory.accounts) {
        const follows =
          account.kind === 'runtime' ||
          (account.ownList.status === 'known' && followsProviderList(account.ownList.rules));
        if (follows && !map.has(account.name)) map.set(account.name, failure.message);
      }
    }
    return map;
  }, [draft.save, inventory]);

  const saveBar = (bar: ReactNode) => (saveDock ? createPortal(bar, saveDock) : bar);

  const apiKeysNote = (
    <>
      {t('model_access.api_keys_note')} <Link to="/ai-providers">{t('nav.ai_providers')}</Link>
    </>
  );

  const renderAccess = () => {
    if (!inventory) return null;
    if (inventory.accounts.length === 0) {
      return (
        <SectionState kind="empty">
          <EmptyState
            title={t('model_access.empty_title')}
            description={t('model_access.empty_desc')}
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate('/auth-files')}>
                {t('model_access.open_auth_files')}
              </Button>
            }
          />
        </SectionState>
      );
    }
    return (
      <>
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
        <div className={styles.legendRow}>
          {isPhone ? (
            // Background on a phone: one tap away, so the list starts on the first screen.
            <details className={styles.keyDisclosure}>
              <summary>{t('model_access.key_label')}</summary>
              <AccessKey titled={false} />
            </details>
          ) : (
            <AccessKey />
          )}
          {/* Always rendered, so the table never moves when the note appears. */}
          <span className={styles.scrollNote} aria-live="polite">
            {overflowing && !isPhone
              ? t('model_access.models_scroll', { count: visibleRows.length })
              : ''}
          </span>
          {/* Where hidden models went, above the fold: opens the Hidden group and goes to it. */}
          {hiddenShown > 0 && !hiddenOpen && !hiddenBandInView && (
            <button
              type="button"
              className={styles.hiddenJump}
              onClick={() => {
                setHiddenOpen(true);
                requestAnimationFrame(() =>
                  sectionRef.current
                    ?.querySelector('[data-section="hidden"]')
                    ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                );
              }}
              data-hidden-jump
            >
              <IconEye size={14} />
              <Trans
                i18nKey="model_access.hidden_jump"
                values={{ count: hiddenShown }}
                components={{ count: <span className={styles.sectionCount} /> }}
              />
            </button>
          )}
        </div>
        {visibleRows.length === 0 || visibleAccounts.length === 0 ? (
          <SectionState kind="no-rows">
            <EmptyState
              title={t('model_access.no_rows')}
              action={
                <Button size="sm" variant="secondary" onClick={onClearFilters}>
                  {t('model_access.clear_filters')}
                </Button>
              }
            />
          </SectionState>
        ) : (
          <ModelAccessMatrix
            provider={getTypeLabel(t, provider)}
            inventory={inventory}
            overrides={draft.overrides}
            rows={visibleRows}
            accounts={visibleAccounts}
            disabled={saving || edit.session.status !== 'idle'}
            layout={isPhone ? 'list' : 'table'}
            failed={failed}
            onStage={draft.stage}
            onOverflowChange={setOverflowing}
            hidden={hidden}
            hiddenOpen={hiddenOpen}
            onHiddenOpenChange={setHiddenOpen}
            searching={modelQuery.trim() !== ''}
            onHide={setModelsHidden}
            note={apiKeysNote}
          />
        )}
        {saveBar(
          <AccessSaveBar
            hub={showHeading ? scope.source.label : null}
            accounts={inventory.accounts}
            changes={draft.changes}
            plan={draft.plan}
            save={draft.save}
            onSave={() => void draft.commit()}
            onDiscard={draft.discard}
          />
        )}
        {/* Inside the grid as its last row; here only when no grid is shown. */}
        {(visibleRows.length === 0 || visibleAccounts.length === 0) && (
          <p className={styles.matrixNote}>{apiKeysNote}</p>
        )}
      </>
    );
  };

  let content: ReactNode;
  if (load.status === 'idle' || load.status === 'loading') {
    content = (
      <SectionState kind="loading">
        <p role="status" className={styles.loadingNote}>
          {t('model_access.loading')}
        </p>
        <SectionSkeleton />
      </SectionState>
    );
  } else if (load.status === 'error' && !inventory) {
    content = (
      <SectionState kind={load.unsupported ? 'unsupported' : 'error'}>
        <EmptyState
          icon={<IconAlertTriangle size={20} />}
          title={
            load.unsupported ? t('model_access.summary_unsupported') : t('model_access.error_title')
          }
          description={
            load.unsupported
              ? load.message
              : t('model_access.error_desc', { message: load.message })
          }
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void reload({ credentials: true })}
            >
              {t('model_access.retry_load')}
            </Button>
          }
        />
      </SectionState>
    );
  } else if (tab === 'access') {
    content = renderAccess();
  } else if (tab === 'rules' && inventory) {
    content = (
      <ModelRulesPanel
        inventory={inventory}
        listKey={listKey}
        onListKeyChange={(key) => setParam({ list: key, listHub: hubId })}
        disabled={busy}
        onReview={(target, rules) => edit.start({ type: 'replace-list', target, rules })}
      />
    );
  } else {
    content = <ModelAliasesPanel provider={provider} disabled={busy} />;
  }

  return (
    <div
      ref={sectionRef}
      className={styles.hubBody}
      data-machine="model-inventory"
      data-state={load.status}
      data-hub={hubId}
    >
      {showHeading && <HubHeading label={scope.source.label} id={hubId} />}
      {load.status === 'error' && inventory && (
        <p className={styles.banner} data-tone="danger" role="alert">
          {t('model_access.refresh_failed', { message: load.message })}
        </p>
      )}
      {content}
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
    </div>
  );
}

export function HubHeading({ label, id }: { label: string; id: string }) {
  return (
    <h2 className={styles.hubHeading}>
      {label} <code>{id}</code>
    </h2>
  );
}
