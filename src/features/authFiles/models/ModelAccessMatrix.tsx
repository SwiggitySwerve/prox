import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconAlertTriangle } from '@/components/ui/icons';
import {
  isAccountEditable,
  isCellToggleable,
  type AccountAccess,
  type CellState,
  type ListTarget,
  type MatrixRow,
} from '@/features/authFiles/modelAccess';
import {
  accountListKind,
  cellDrift,
  cellLabelKey,
  cellRule,
  cellShortKey,
  nextExcludeFor,
  rowActionFor,
  sharedLabels,
} from './matrixView';
import styles from './ModelsPage.module.scss';

export type LockedCellInfo = {
  model: string;
  /** Display label of the account (or the provider, for the provider list). */
  account: string;
  /** Credential file name: the identity used to open its list. Absent for the provider list. */
  accountName?: string;
  rule: string;
  list: 'account' | 'provider';
};

type Props = {
  /** Display name of the provider. */
  provider: string;
  rows: MatrixRow[];
  accounts: AccountAccess[];
  /** Writes are blocked (a session is open, or the inventory is refreshing). */
  disabled: boolean;
  /** `table` from 600 px up; `list` shows one account (or the provider list) at a time. */
  layout: 'table' | 'list';
  onToggleCell: (account: AccountAccess, model: string, exclude: boolean) => void;
  onLockedCell: (info: LockedCellInfo) => void;
  onEverywhere: (model: string, exclude: boolean) => void;
  onProviderDefault: (model: string, exclude: boolean) => void;
  onAccountAll: (account: AccountAccess, exclude: boolean) => void;
  /** Every account that could serve the model is locked by a wildcard: open that rule. */
  onEditRule: (target: ListTarget) => void;
  /** The table is wider than its frame (some account columns are scrolled out of view). */
  onOverflowChange?: (overflow: boolean) => void;
};

/** Lock glyph for wildcard cells; same stroke style as the shared icon set. */
function LockGlyph() {
  return (
    <svg
      className={styles.lockGlyph}
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

const PROVIDER_VIEW = 'provider';
const accountViewKey = (name: string) => `account:${name}`;

/** One-line key for the cell colours; shown above the table and the phone list. */
export function ModelAccessLegend() {
  const { t } = useTranslation();
  const items: Array<{ kind: string; label: string; title?: string }> = [
    { kind: 'served', label: t('model_access.legend_served') },
    { kind: 'excluded-provider', label: t('model_access.legend_excluded') },
    { kind: 'wildcard', label: t('model_access.legend_locked') },
    {
      kind: 'no-access',
      label: t('model_access.legend_no_access'),
      title: t('model_access.legend_no_access_title'),
    },
    { kind: 'disabled', label: t('model_access.legend_account_off') },
  ];
  return (
    <ul className={styles.legend} aria-label={t('model_access.legend_label')}>
      {items.map((item) => (
        <li key={item.kind} title={item.title}>
          <span className={styles.legendSwatch} data-kind={item.kind} aria-hidden="true" />
          {item.label}
          {item.title && <span className={styles.srOnly}>: {item.title}</span>}
        </li>
      ))}
    </ul>
  );
}

export function ModelAccessMatrix(props: Props) {
  const { t } = useTranslation();
  const { provider, rows, accounts, disabled, layout } = props;
  const shared = sharedLabels(accounts);

  /** The full sentence for a cell: aria-label and tooltip. */
  const stateText = (cell: CellState) => {
    const rule = cellRule(cell);
    const base = t(`model_access.${cellLabelKey(cell)}`, { rule: rule ?? '' });
    return cellDrift(cell) ? `${base} · ${t('model_access.cell_drift')}` : base;
  };

  /** Short visible text; a wildcard shows a lock and its rule. */
  const cellContent = (cell: CellState): ReactNode => (
    <>
      {cell.kind === 'wildcard' && <LockGlyph />}
      <span className={styles.cellText}>
        {t(`model_access.${cellShortKey(cell)}`, { rule: cellRule(cell) ?? '' })}
      </span>
    </>
  );

  const renderAccountCell = (account: AccountAccess, row: MatrixRow) => {
    const cell = row.cells[account.name] ?? { kind: 'unknown' };
    const label = t('model_access.cell_aria', {
      model: row.model,
      account: account.label,
      state: stateText(cell),
    });
    const id = `${account.name}::${row.model}`;
    const common = {
      className: styles.cell,
      'data-kind': cell.kind,
      'data-cell': id,
      'data-state': cell.kind,
      'data-drift': cellDrift(cell) ? 'true' : undefined,
    };
    if (isAccountEditable(account) && isCellToggleable(cell)) {
      const exclude = nextExcludeFor(cell);
      const full = `${label}. ${
        exclude ? t('model_access.cell_action_exclude') : t('model_access.cell_action_include')
      }`;
      return (
        <button
          type="button"
          {...common}
          disabled={disabled}
          aria-label={full}
          title={full}
          onClick={() => props.onToggleCell(account, row.model, exclude)}
        >
          {cellContent(cell)}
        </button>
      );
    }
    if (cell.kind === 'wildcard') {
      const full = `${label}. ${t('model_access.cell_action_locked')}`;
      return (
        <button
          type="button"
          {...common}
          aria-label={full}
          title={full}
          onClick={() =>
            props.onLockedCell({
              model: row.model,
              account: account.label,
              accountName: account.name,
              rule: cell.rule,
              list: cell.list,
            })
          }
        >
          {cellContent(cell)}
        </button>
      );
    }
    return (
      <span {...common} role="img" aria-label={label} title={label}>
        {cellContent(cell)}
      </span>
    );
  };

  const providerStateText = (row: MatrixRow) =>
    row.provider.excluded
      ? row.provider.wildcard
        ? t('model_access.provider_cell_wildcard', { rule: row.provider.rule })
        : t('model_access.provider_cell_excluded')
      : t('model_access.provider_cell_open');

  const renderProviderCell = (row: MatrixRow) => {
    const state = providerStateText(row);
    if (row.provider.excluded && row.provider.wildcard) {
      const { rule } = row.provider;
      const full = t('model_access.provider_cell_locked_aria', { model: row.model, state });
      return (
        <button
          type="button"
          className={styles.cell}
          data-kind="wildcard"
          data-provider-cell={row.model}
          aria-label={full}
          title={full}
          onClick={() =>
            props.onLockedCell({ model: row.model, account: provider, rule, list: 'provider' })
          }
        >
          <LockGlyph />
          <span className={styles.cellText}>{rule}</span>
        </button>
      );
    }
    const full = t('model_access.provider_cell_aria', { model: row.model, state });
    return (
      <button
        type="button"
        className={styles.cell}
        data-kind={row.provider.excluded ? 'excluded-provider' : 'open'}
        data-provider-cell={row.model}
        disabled={disabled}
        aria-label={full}
        title={full}
        onClick={() => props.onProviderDefault(row.model, !row.provider.excluded)}
      >
        <span className={styles.cellText}>{state}</span>
      </button>
    );
  };

  const renderRowAction = (row: MatrixRow) => {
    const action = rowActionFor(row);
    const title =
      action.kind === 'exclude'
        ? t('model_access.row_exclude_everywhere')
        : action.kind === 'include'
          ? t('model_access.row_include_everywhere')
          : t('model_access.row_edit_rule_title');
    return (
      <button
        type="button"
        className={styles.rowAction}
        data-row-action={row.model}
        data-action={action.kind}
        disabled={action.kind !== 'edit-rule' && disabled}
        aria-label={t('model_access.row_action_aria', { action: title, model: row.model })}
        title={title}
        onClick={() =>
          action.kind === 'edit-rule'
            ? props.onEditRule(action.target)
            : props.onEverywhere(row.model, action.kind === 'exclude')
        }
      >
        {action.kind === 'exclude'
          ? t('model_access.action_exclude')
          : action.kind === 'include'
            ? t('model_access.action_include')
            : t('model_access.edit_rule')}
      </button>
    );
  };

  /** Served-by count, alias, "only X" and "not in catalog" in one compact line. */
  const renderRowMeta = (row: MatrixRow) => {
    const total = Object.keys(row.cells).length;
    const count = row.servedBy.length;
    const only =
      count === 1
        ? (accounts.find((item) => item.name === row.servedBy[0])?.label ?? row.servedBy[0])
        : null;
    const servedText = only
      ? t('model_access.row_only_one', { account: only })
      : count > 0
        ? t('model_access.row_served_count', { count, total })
        : t('model_access.row_none');
    return (
      <span className={styles.modelMeta}>
        <span
          className={only ? styles.onlyOne : count > 0 ? styles.servedCount : styles.notServed}
          data-single-account={only ? row.model : undefined}
          title={servedText}
        >
          {only && <IconAlertTriangle size={12} aria-hidden="true" />}
          <span aria-hidden="true">{t('model_access.row_served_short', { count, total })}</span>
          <span className={styles.srOnly}>{servedText}</span>
        </span>
        {row.aliases.map((alias) => (
          <span
            key={alias}
            className={styles.aliasChip}
            title={t('model_access.alias_chip', { alias })}
          >
            {t('model_access.alias_chip', { alias })}
          </span>
        ))}
        {!row.inCatalog && (
          <span className={styles.metaNote}>{t('model_access.row_not_in_catalog')}</span>
        )}
      </span>
    );
  };

  const renderAccountActions = (account: AccountAccess) => {
    const kind = accountListKind(account);
    if (account.disabled || kind === 'runtime') return null;
    return (
      <span className={styles.accountActions}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={disabled || account.ownList.status !== 'known'}
          onClick={() => props.onAccountAll(account, true)}
          aria-label={t('model_access.account_exclude_all_aria', { account: account.label })}
          title={t('model_access.account_exclude_all_aria', { account: account.label })}
        >
          {t('model_access.account_exclude_all')}
        </button>
        {kind === 'own' && (
          <button
            type="button"
            className={styles.miniButton}
            disabled={disabled}
            onClick={() => props.onAccountAll(account, false)}
            aria-label={t('model_access.account_use_provider_aria', { account: account.label })}
            title={t('model_access.account_use_provider_aria', { account: account.label })}
          >
            {t('model_access.account_use_provider')}
          </button>
        )}
      </span>
    );
  };

  const renderBadge = (account: AccountAccess) => {
    const kind = account.disabled ? 'disabled' : accountListKind(account);
    const full = t(`model_access.badge_${kind}`);
    return (
      <span className={styles.accountBadge} data-list={kind} title={full}>
        {kind === 'runtime' ? t('model_access.badge_runtime_short') : full}
      </span>
    );
  };

  if (layout === 'list') {
    return (
      <ModelAccessList
        provider={provider}
        rows={rows}
        accounts={accounts}
        renderAccountCell={renderAccountCell}
        renderProviderCell={renderProviderCell}
        providerStateText={providerStateText}
        renderRowAction={renderRowAction}
        renderRowMeta={renderRowMeta}
        renderBadge={renderBadge}
        renderAccountActions={renderAccountActions}
      />
    );
  }

  return (
    <MatrixTable
      provider={provider}
      accountCount={accounts.length}
      onOverflowChange={props.onOverflowChange}
    >
      <thead>
        <tr>
          <th scope="col" className={styles.modelColumn}>
            {t('model_access.column_model')}
          </th>
          <th scope="col" className={styles.providerColumn}>
            {t('model_access.column_provider')}
          </th>
          {accounts.map((account) => {
            const kind = account.disabled ? 'disabled' : accountListKind(account);
            const twin = shared.has(account.label);
            return (
              <th key={account.name} scope="col" className={styles.accountColumn} data-list={kind}>
                <span
                  className={styles.accountLabel}
                  title={twin ? `${account.label}\n${account.name}` : account.label}
                >
                  {account.label}
                </span>
                {twin && (
                  <span className={styles.accountFile} title={account.name}>
                    {account.name}
                  </span>
                )}
                <span className={styles.accountMeta}>
                  {renderBadge(account)}
                  {renderAccountActions(account)}
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
            <th scope="row" className={styles.modelColumn}>
              <span className={styles.modelLine}>
                <span className={styles.modelText}>
                  <span className={styles.modelId} title={row.model}>
                    {row.model}
                  </span>
                  {renderRowMeta(row)}
                </span>
                {renderRowAction(row)}
              </span>
            </th>
            <td className={styles.providerColumn}>{renderProviderCell(row)}</td>
            {accounts.map((account) => (
              <td key={account.name}>{renderAccountCell(account, row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </MatrixTable>
  );
}

/**
 * The scrolling frame. Edge fades (data attributes, no re-render) say columns are hidden to the
 * left or right; `onOverflowChange` lets the page add a text note for the same fact.
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

/** Under 600 px: one account (or the provider list) at a time, one row per model. */
function ModelAccessList({
  provider,
  rows,
  accounts,
  renderAccountCell,
  renderProviderCell,
  providerStateText,
  renderRowAction,
  renderRowMeta,
  renderBadge,
  renderAccountActions,
}: {
  provider: string;
  rows: MatrixRow[];
  accounts: AccountAccess[];
  renderAccountCell: (account: AccountAccess, row: MatrixRow) => ReactNode;
  renderProviderCell: (row: MatrixRow) => ReactNode;
  providerStateText: (row: MatrixRow) => string;
  renderRowAction: (row: MatrixRow) => ReactNode;
  renderRowMeta: (row: MatrixRow) => ReactNode;
  renderBadge: (account: AccountAccess) => ReactNode;
  renderAccountActions: (account: AccountAccess) => ReactNode;
}) {
  const { t } = useTranslation();
  const labelId = `${useId()}-account-picker`;
  const shared = sharedLabels(accounts);
  const [choice, setChoice] = useState<string | null>(null);
  // Default: the first account. A chosen account that is filtered out falls back to it too.
  const selected =
    choice === PROVIDER_VIEW ||
    (choice !== null && accounts.some((account) => accountViewKey(account.name) === choice))
      ? choice
      : accounts[0]
        ? accountViewKey(accounts[0].name)
        : PROVIDER_VIEW;
  const account =
    selected === PROVIDER_VIEW
      ? null
      : (accounts.find((item) => accountViewKey(item.name) === selected) ?? null);
  const options = [
    ...accounts.map((item) => ({
      value: accountViewKey(item.name),
      label: shared.has(item.label) ? `${item.label} (${item.name})` : item.label,
    })),
    { value: PROVIDER_VIEW, label: t('model_access.target_provider', { provider }) },
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
        {account && (
          <span className={styles.accountMeta}>
            {renderBadge(account)}
            {renderAccountActions(account)}
          </span>
        )}
      </div>
      <ul className={styles.phoneRows} aria-label={t('model_access.matrix_label', { provider })}>
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
              {renderRowMeta(row)}
              {account && (
                <span className={styles.phoneSub}>
                  {t('model_access.phone_provider_state', { state: providerStateText(row) })}
                </span>
              )}
            </span>
            <span className={styles.phoneCell}>
              {account ? renderAccountCell(account, row) : renderProviderCell(row)}
            </span>
            {renderRowAction(row)}
          </li>
        ))}
      </ul>
    </div>
  );
}
