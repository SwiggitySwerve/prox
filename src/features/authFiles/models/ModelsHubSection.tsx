import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAuthFilesSource } from '@/features/authFiles/AuthFilesSourceContext';
import { getTypeLabel } from '@/features/authFiles/constants';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { useModelAccessInventory } from '@/features/authFiles/hooks/useModelAccessInventory';
import { useModelEditSession } from '@/features/authFiles/hooks/useModelEditSession';
import { buildMatrix, inventoryOf, type ListTarget } from '@/features/authFiles/modelAccess';
import { ModelAccessLegend, ModelAccessMatrix, type LockedCellInfo } from './ModelAccessMatrix';
import { LockedCellDialog, ModelEditDialog } from './ModelEditDialog';
import { ModelAliasesPanel } from './ModelAliasesPanel';
import { ModelRulesPanel } from './ModelRulesPanel';
import {
  countServed,
  filterAccounts,
  filterRows,
  listKeyOf,
  resolveListKey,
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
  const [locked, setLocked] = useState<LockedCellInfo | null>(null);
  const [overflowing, setOverflowing] = useState(false);

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

  const rows = useMemo(() => (inventory ? buildMatrix(inventory) : []), [inventory]);
  const visibleRows = useMemo(() => filterRows(rows, modelQuery, view), [rows, modelQuery, view]);
  const visibleAccounts = useMemo(
    () => (inventory ? filterAccounts(inventory.accounts, accountQuery) : []),
    [inventory, accountQuery]
  );
  const counts = countServed(visibleRows);
  const showsTable = tab === 'access' && inventory !== null && inventory.accounts.length > 0;
  const models = showsTable ? visibleRows.length : 0;
  const served = showsTable ? counts.served : 0;
  const accounts = showsTable ? visibleAccounts.length : 0;
  useEffect(() => {
    reportCounts(hubId, showsTable ? { models, served, accounts } : null);
  }, [accounts, hubId, models, reportCounts, served, showsTable]);
  useEffect(() => () => reportCounts(hubId, null), [hubId, reportCounts]);

  const unreadable =
    inventory?.accounts.filter(
      (account) => account.kind === 'file' && account.ownList.status !== 'known'
    ) ?? [];
  const busy =
    edit.session.status !== 'idle' || load.status === 'refreshing' || load.status === 'loading';

  // The hub goes with the list: another hub may hold a credential file of the same name.
  const openRules = (target: ListTarget) =>
    setParam({ tab: 'rules', list: listKeyOf(target), listHub: hubId });
  const goToRule = (info: LockedCellInfo) => {
    setLocked(null);
    openRules(
      info.list === 'provider' || !info.accountName
        ? { kind: 'provider' }
        : { kind: 'account', name: info.accountName }
    );
  };

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
                {t('nav.auth_files')}
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
          <ModelAccessLegend />
          {/* Always rendered, so the table never moves when the note appears. */}
          <span className={styles.scrollNote} aria-live="polite">
            {overflowing && !isPhone
              ? t('model_access.models_scroll', { count: visibleRows.length })
              : ''}
          </span>
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
        )}
        <p className={styles.matrixNote}>
          {t('model_access.api_keys_note')} <Link to="/ai-providers">{t('nav.ai_providers')}</Link>
        </p>
      </>
    );
  };

  let content: ReactNode;
  if (load.status === 'idle' || load.status === 'loading') {
    content = (
      <SectionState kind="loading">
        <p role="status" className={styles.srOnly}>
          {t('model_access.loading')}
        </p>
        <SectionSkeleton />
      </SectionState>
    );
  } else if (load.status === 'error' && !inventory) {
    content = (
      <SectionState kind={load.unsupported ? 'unsupported' : 'error'}>
        <EmptyState
          title={
            load.unsupported ? t('model_access.summary_unsupported') : t('model_access.error_title')
          }
          description={load.message}
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
      <LockedCellDialog info={locked} onClose={() => setLocked(null)} onEditRule={goToRule} />
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
