import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import {
  accessCell,
  type AccessCell,
  type AccessChange,
  type AccessOverrides,
  type AccountAccess,
  type MatrixRow,
  type ModelAccessInventory,
} from '@/features/authFiles/modelAccess';
import { sharedLabels } from './matrixView';
import styles from './ModelsPage.module.scss';

type Props = {
  /** Display name of the provider. */
  provider: string;
  inventory: ModelAccessInventory;
  overrides: AccessOverrides;
  /** One per model row, newest first. */
  rows: MatrixRow[];
  /** One per account column (table) or picker option (phone list). */
  accounts: AccountAccess[];
  /** Switches are locked (a Save is running). */
  disabled: boolean;
  /** `table` from 600 px up; `list` shows one account (or all of them) at a time. */
  layout: 'table' | 'list';
  /** Accounts whose last Save did not land, with why. */
  failed: ReadonlyMap<string, string>;
  onStage: (changes: AccessChange[]) => void;
  /** The accounts do not fit and the table scrolls sideways inside its frame. */
  onOverflowChange?: (overflow: boolean) => void;
};

type SwitchState = 'on' | 'off' | 'mixed';

/** On, off, or mixed over the cells that are switches; null when none is. */
function combined(
  cells: readonly AccessCell[]
): { state: SwitchState; on: number; total: number } | null {
  const switches = cells.filter(
    (cell): cell is Extract<AccessCell, { kind: 'switch' }> => cell.kind === 'switch'
  );
  if (switches.length === 0) return null;
  const on = switches.filter((cell) => cell.on).length;
  return {
    state: on === switches.length ? 'on' : on === 0 ? 'off' : 'mixed',
    on,
    total: switches.length,
  };
}

/**
 * The one control of the grid. A cell is a two-state switch; a model or account switch is
 * tri-state (a checkbox that looks like a switch), because its accounts or models may differ.
 */
function AccessSwitch({
  state,
  changed = false,
  tri = false,
  disabled,
  label,
  onToggle,
  ...data
}: {
  state: SwitchState;
  changed?: boolean;
  tri?: boolean;
  disabled: boolean;
  label: string;
  onToggle: (on: boolean) => void;
  [dataAttribute: `data-${string}`]: string | undefined;
}) {
  return (
    <button
      type="button"
      role={tri ? 'checkbox' : 'switch'}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      title={label}
      className={styles.switch}
      data-state={state}
      data-changed={changed ? 'true' : undefined}
      disabled={disabled}
      // Mixed turns on, like any tri-state checkbox; the next press turns it off.
      onClick={() => onToggle(state !== 'on')}
      {...data}
    >
      <span className={styles.switchThumb} aria-hidden="true" />
    </button>
  );
}

/** An email reads best split at the @: the name on one line, the domain under it. */
function AccountName({ label }: { label: string }) {
  const at = label.indexOf('@');
  if (at <= 0) return <>{label}</>;
  return (
    <>
      <span className={styles.labelLine}>{label.slice(0, at)}</span>
      <span className={styles.labelLine}>{label.slice(at)}</span>
    </>
  );
}

export function ModelAccessMatrix(props: Props) {
  const { t } = useTranslation();
  const { provider, inventory, overrides, rows, accounts, disabled, layout, failed } = props;
  const shared = sharedLabels(accounts);

  const cellOf = (account: AccountAccess, row: MatrixRow) =>
    accessCell(inventory, overrides, account, row.model);

  /** One model across the visible accounts; one account across the visible models. */
  const modelState = (row: MatrixRow) => combined(accounts.map((account) => cellOf(account, row)));
  const accountState = (account: AccountAccess) =>
    combined(rows.map((row) => cellOf(account, row)));

  const stageModel = (row: MatrixRow, on: boolean) =>
    props.onStage(accounts.map((account) => ({ account: account.name, model: row.model, on })));
  const stageAccount = (account: AccountAccess, on: boolean) =>
    props.onStage(rows.map((row) => ({ account: account.name, model: row.model, on })));

  const renderCell = (account: AccountAccess, row: MatrixRow) => {
    const cell = cellOf(account, row);
    const id = `${account.name}::${row.model}`;
    if (cell.kind === 'switch') {
      return (
        <AccessSwitch
          state={cell.on ? 'on' : 'off'}
          changed={cell.changed}
          disabled={disabled}
          label={t('model_access.grid_cell_aria', { model: row.model, account: account.label })}
          onToggle={(on) => props.onStage([{ account: account.name, model: row.model, on }])}
          data-cell={id}
        />
      );
    }
    const label =
      cell.kind === 'none'
        ? t('model_access.grid_none', { model: row.model, account: account.label })
        : t('model_access.grid_unknown');
    return (
      <span
        className={styles.noSwitch}
        data-cell={id}
        data-kind={cell.kind}
        role="img"
        aria-label={label}
        title={label}
      >
        {cell.kind === 'none' ? '—' : '?'}
      </span>
    );
  };

  /** The switch at the start of a model row: that model for every account. */
  const renderModelSwitch = (row: MatrixRow) => {
    const state = modelState(row);
    if (!state) return <span className={styles.switchSpacer} aria-hidden="true" />;
    return (
      <AccessSwitch
        tri
        state={state.state}
        disabled={disabled}
        label={t('model_access.grid_model_aria', { model: row.model })}
        onToggle={(on) => stageModel(row, on)}
        data-model-switch={row.model}
      />
    );
  };

  const modelCount = (row: MatrixRow) => {
    const state = modelState(row);
    return (
      <span className={styles.countText}>
        {state ? t('model_access.grid_on_count', { on: state.on, total: state.total }) : '—'}
      </span>
    );
  };

  /** The switch in an account's column header: every model for that account. */
  const renderAccountSwitch = (account: AccountAccess) => {
    const state = accountState(account);
    if (!state) return <span className={styles.switchSpacer} aria-hidden="true" />;
    return (
      <AccessSwitch
        tri
        state={state.state}
        disabled={disabled}
        label={t('model_access.grid_account_aria', { account: account.label })}
        onToggle={(on) => stageAccount(account, on)}
        data-account-switch={account.name}
      />
    );
  };

  /** "Account off", "Couldn't read" and "Not saved", where they apply. */
  const renderMarkers = (account: AccountAccess) => {
    const failure = failed.get(account.name);
    return (
      <>
        {account.disabled && (
          <span className={styles.marker} data-marker="off">
            {t('model_access.grid_account_off')}
          </span>
        )}
        {account.ownList.status !== 'known' && (
          <span
            className={styles.marker}
            data-marker="unknown"
            title={t('model_access.grid_unknown')}
          >
            {t('model_access.grid_unknown_short')}
          </span>
        )}
        {failure !== undefined && (
          <span className={styles.marker} data-marker="failed" title={failure} role="status">
            {t('model_access.grid_not_saved')}
          </span>
        )}
      </>
    );
  };

  if (layout === 'list') {
    return (
      <AccessList
        provider={provider}
        rows={rows}
        accounts={accounts}
        shared={shared}
        renderCell={renderCell}
        renderModelSwitch={(row) => (
          <span className={styles.headSwitch}>
            {renderModelSwitch(row)}
            {modelCount(row)}
          </span>
        )}
        renderAccountSwitch={renderAccountSwitch}
        renderMarkers={renderMarkers}
      />
    );
  }

  return (
    <MatrixTable
      provider={provider}
      accountCount={accounts.length}
      onOverflowChange={props.onOverflowChange}
    >
      <colgroup>
        <col className={styles.headCol} />
        {accounts.map((account) => (
          <col key={account.name} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={styles.corner}>
            <span className={styles.cornerAccounts}>
              {t('model_access.column_account')} <span aria-hidden="true">→</span>
            </span>
            <span className={styles.cornerModels}>
              {t('model_access.column_model')} <span aria-hidden="true">↓</span>
            </span>
          </th>
          {accounts.map((account) => {
            const twin = shared.has(account.label);
            const state = accountState(account);
            return (
              <th
                key={account.name}
                scope="col"
                className={styles.accountHead}
                data-account={account.name}
                data-off={account.disabled ? 'true' : undefined}
                data-failed={failed.has(account.name) ? 'true' : undefined}
              >
                <span className={styles.accountHeadInner}>
                  <span
                    className={styles.accountLabel}
                    title={twin ? `${account.label}\n${account.name}` : account.label}
                  >
                    <AccountName label={account.label} />
                  </span>
                  <span className={styles.accountSub}>
                    {renderMarkers(account)}
                    {twin && (
                      <span className={styles.rowFile} title={account.name}>
                        {account.name}
                      </span>
                    )}
                  </span>
                  <span className={styles.accountSwitch}>
                    {renderAccountSwitch(account)}
                    <span className={styles.countText}>
                      {state
                        ? t('model_access.grid_on_count', { on: state.on, total: state.total })
                        : ''}
                    </span>
                  </span>
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.model}
            data-model={row.model}
            data-served={row.servedBy.length ? 'yes' : 'no'}
          >
            <th scope="row" className={styles.rowHead}>
              <span className={styles.rowHeadInner}>
                {renderModelSwitch(row)}
                <span className={styles.modelText}>
                  <span className={styles.modelId} title={row.model}>
                    {row.model}
                  </span>
                  {modelCount(row)}
                </span>
              </span>
            </th>
            {accounts.map((account) => (
              <td
                key={account.name}
                className={styles.switchCell}
                data-off={account.disabled ? 'true' : undefined}
              >
                {renderCell(account, row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </MatrixTable>
  );
}

/**
 * The frame. Account columns share its width, so it does not scroll sideways; only when even the
 * narrowest columns cannot fit does it scroll inside itself (never the page). Edge fades (data
 * attributes, no re-render) then say columns are hidden, and `onOverflowChange` adds a text note.
 */
function MatrixTable({
  provider,
  accountCount,
  onOverflowChange,
  children,
}: {
  provider: string;
  accountCount: number;
  onOverflowChange?: (overflow: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const notifyRef = useRef(onOverflowChange);
  useEffect(() => {
    notifyRef.current = onOverflowChange;
  });

  useEffect(() => {
    const frame = frameRef.current;
    const scroller = scrollRef.current;
    if (!frame || !scroller) return;
    let overflowing: boolean | null = null;
    const update = () => {
      const hidden = scroller.scrollWidth - scroller.clientWidth;
      frame.dataset.fadeLeft = String(scroller.scrollLeft > 1);
      frame.dataset.fadeRight = String(scroller.scrollLeft < hidden - 1);
      const next = hidden > 1;
      if (next !== overflowing) {
        overflowing = next;
        notifyRef.current?.(next);
      }
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    if (tableRef.current) observer?.observe(tableRef.current);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
      notifyRef.current?.(false);
    };
  }, []);

  return (
    <div
      ref={frameRef}
      className={styles.matrixFrame}
      data-fade-left="false"
      data-fade-right="false"
    >
      <div
        ref={scrollRef}
        className={styles.matrixScroll}
        role="region"
        aria-label={t('model_access.matrix_label', { provider })}
        tabIndex={0}
      >
        <table
          ref={tableRef}
          className={styles.matrix}
          style={{ '--account-count': accountCount } as CSSProperties}
        >
          {children}
        </table>
      </div>
    </div>
  );
}

const ALL_ACCOUNTS = 'all';
const accountViewKey = (name: string) => `account:${name}`;

/** Under 600 px: all accounts (model switches) or one account at a time, one row per model. */
function AccessList({
  provider,
  rows,
  accounts,
  shared,
  renderCell,
  renderModelSwitch,
  renderAccountSwitch,
  renderMarkers,
}: {
  provider: string;
  rows: MatrixRow[];
  accounts: AccountAccess[];
  shared: Set<string>;
  renderCell: (account: AccountAccess, row: MatrixRow) => ReactNode;
  renderModelSwitch: (row: MatrixRow) => ReactNode;
  renderAccountSwitch: (account: AccountAccess) => ReactNode;
  renderMarkers: (account: AccountAccess) => ReactNode;
}) {
  const { t } = useTranslation();
  const labelId = `${useId()}-account-picker`;
  const [choice, setChoice] = useState<string>(ALL_ACCOUNTS);
  // A chosen account that is filtered out falls back to all accounts.
  const account = accounts.find((item) => accountViewKey(item.name) === choice) ?? null;
  const selected = account ? choice : ALL_ACCOUNTS;
  const options = [
    {
      value: ALL_ACCOUNTS,
      label: t('model_access.phone_all_accounts', { count: accounts.length }),
    },
    ...accounts.map((item) => ({
      value: accountViewKey(item.name),
      label: shared.has(item.label) ? `${item.label} (${item.name})` : item.label,
    })),
  ];

  return (
    <div className={styles.phoneView} data-layout="list">
      <div className={styles.phonePicker}>
        <label id={labelId} className={styles.phonePickerLabel}>
          {t('model_access.account_picker')}
        </label>
        <Select
          value={selected}
          options={options}
          onChange={setChoice}
          ariaLabelledBy={labelId}
          size="sm"
          fullWidth
        />
      </div>
      <ul className={styles.phoneRows} aria-label={t('model_access.matrix_label', { provider })}>
        {account && (
          <li
            className={styles.phoneAll}
            data-account={account.name}
            data-off={account.disabled ? 'true' : undefined}
          >
            <span className={styles.phoneModel}>
              <span className={styles.rowLabel}>{t('model_access.phone_all_models')}</span>
              <span className={styles.rowSub}>{renderMarkers(account)}</span>
            </span>
            {renderAccountSwitch(account)}
          </li>
        )}
        {rows.map((row) => (
          <li
            key={row.model}
            data-model={row.model}
            data-served={row.servedBy.length ? 'yes' : 'no'}
          >
            <span className={styles.phoneModel}>
              <span className={styles.modelId} title={row.model}>
                {row.model}
              </span>
            </span>
            <span className={styles.phoneCell}>
              {account ? renderCell(account, row) : renderModelSwitch(row)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
