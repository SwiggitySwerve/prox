import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@/components/ui/icons';
import {
  isCellToggleable,
  type AccountAccess,
  type CellState,
  type MatrixRow,
} from '@/features/authFiles/modelAccess';
import { accountListKind, cellDrift, cellLabelKey, cellRule, nextExcludeFor } from './matrixView';
import styles from './ModelsPage.module.scss';

export type LockedCellInfo = {
  model: string;
  account: string;
  rule: string;
  list: 'account' | 'provider';
};

type Props = {
  provider: string;
  rows: MatrixRow[];
  accounts: AccountAccess[];
  /** Writes are blocked (a session is open, or the inventory is refreshing). */
  disabled: boolean;
  onToggleCell: (account: AccountAccess, model: string, exclude: boolean) => void;
  onLockedCell: (info: LockedCellInfo) => void;
  onEverywhere: (model: string, exclude: boolean) => void;
  onProviderDefault: (model: string, exclude: boolean) => void;
  onAccountAll: (account: AccountAccess, exclude: boolean) => void;
};

export function ModelAccessMatrix(props: Props) {
  const { t } = useTranslation();
  const { provider, rows, accounts, disabled } = props;

  const stateText = (cell: CellState) => {
    const rule = cellRule(cell);
    const base = t(`model_access.${cellLabelKey(cell)}`, { rule: rule ?? '' });
    return cellDrift(cell) ? `${base} · ${t('model_access.cell_drift')}` : base;
  };

  return (
    <div
      className={styles.matrixScroll}
      role="region"
      aria-label={t('model_access.matrix_label', { provider })}
      tabIndex={0}
    >
      <table className={styles.matrix}>
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
              return (
                <th
                  key={account.name}
                  scope="col"
                  className={styles.accountColumn}
                  data-list={kind}
                >
                  <span className={styles.accountLabel} title={account.name}>
                    {account.label}
                  </span>
                  <span className={styles.accountBadge} data-list={kind}>
                    {t(`model_access.badge_${kind}`)}
                  </span>
                  <span className={styles.accountActions}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      disabled={disabled || account.ownList.status !== 'known'}
                      onClick={() => props.onAccountAll(account, true)}
                      aria-label={t('model_access.account_exclude_all_aria', {
                        account: account.label,
                      })}
                    >
                      {t('model_access.account_exclude_all')}
                    </button>
                    {kind === 'own' && (
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={disabled}
                        onClick={() => props.onAccountAll(account, false)}
                        aria-label={t('model_access.account_use_provider_aria', {
                          account: account.label,
                        })}
                      >
                        {t('model_access.account_use_provider')}
                      </button>
                    )}
                  </span>
                </th>
              );
            })}
            <th scope="col" className={styles.servedColumn}>
              {t('model_access.column_served_by')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const served = row.servedBy.length > 0;
            const only =
              row.servedBy.length === 1
                ? (accounts.find((item) => item.name === row.servedBy[0])?.label ?? row.servedBy[0])
                : null;
            return (
              <tr key={row.model} data-model={row.model} data-served={served ? 'yes' : 'no'}>
                <th scope="row" className={styles.modelColumn}>
                  <span className={styles.modelId}>{row.model}</span>
                  <span className={styles.modelMeta}>
                    {row.aliases.map((alias) => (
                      <span key={alias} className={styles.aliasChip}>
                        {t('model_access.alias_chip', { alias })}
                      </span>
                    ))}
                    {!row.inCatalog && (
                      <span className={styles.metaNote}>
                        {t('model_access.row_not_in_catalog')}
                      </span>
                    )}
                    {only && (
                      <span className={styles.onlyOne} data-single-account={row.model}>
                        <IconAlertTriangle size={13} aria-hidden="true" />
                        <span>{t('model_access.row_only_one', { account: only })}</span>
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className={styles.rowAction}
                    data-row-action={row.model}
                    disabled={disabled}
                    onClick={() => props.onEverywhere(row.model, served)}
                  >
                    {served
                      ? t('model_access.row_disable_everywhere')
                      : t('model_access.row_enable_everywhere')}
                  </button>
                </th>
                <td className={styles.providerColumn}>
                  {row.provider.excluded && row.provider.wildcard ? (
                    <span className={styles.cell} data-kind="wildcard">
                      {t('model_access.provider_cell_wildcard', { rule: row.provider.rule })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.cell}
                      data-kind={row.provider.excluded ? 'excluded-provider' : 'open'}
                      data-provider-cell={row.model}
                      disabled={disabled}
                      aria-label={t('model_access.provider_cell_aria', {
                        model: row.model,
                        state: row.provider.excluded
                          ? t('model_access.provider_cell_excluded')
                          : t('model_access.provider_cell_open'),
                      })}
                      onClick={() => props.onProviderDefault(row.model, !row.provider.excluded)}
                    >
                      {row.provider.excluded
                        ? t('model_access.provider_cell_excluded')
                        : t('model_access.provider_cell_open')}
                    </button>
                  )}
                </td>
                {accounts.map((account) => {
                  const cell = row.cells[account.name] ?? { kind: 'unknown' };
                  const text = stateText(cell);
                  const label = t('model_access.cell_aria', {
                    model: row.model,
                    account: account.label,
                    state: text,
                  });
                  const id = `${account.name}::${row.model}`;
                  if (isCellToggleable(cell)) {
                    const exclude = nextExcludeFor(cell);
                    return (
                      <td key={account.name}>
                        <button
                          type="button"
                          className={styles.cell}
                          data-kind={cell.kind}
                          data-cell={id}
                          data-state={cell.kind}
                          disabled={disabled}
                          aria-label={`${label}. ${
                            exclude
                              ? t('model_access.cell_action_exclude')
                              : t('model_access.cell_action_include')
                          }`}
                          onClick={() => props.onToggleCell(account, row.model, exclude)}
                        >
                          {text}
                        </button>
                      </td>
                    );
                  }
                  if (cell.kind === 'wildcard') {
                    return (
                      <td key={account.name}>
                        <button
                          type="button"
                          className={styles.cell}
                          data-kind="wildcard"
                          data-cell={id}
                          data-state="wildcard"
                          aria-label={`${label}. ${t('model_access.cell_action_locked')}`}
                          onClick={() =>
                            props.onLockedCell({
                              model: row.model,
                              account: account.label,
                              rule: cell.rule,
                              list: cell.list,
                            })
                          }
                        >
                          {text}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={account.name}>
                      <span
                        className={styles.cell}
                        data-kind={cell.kind}
                        data-cell={id}
                        data-state={cell.kind}
                        role="img"
                        aria-label={label}
                      >
                        {text}
                      </span>
                    </td>
                  );
                })}
                <td className={styles.servedColumn}>
                  {only ? (
                    <span className={styles.onlyOne}>
                      <IconAlertTriangle size={14} aria-hidden="true" />
                      <span>{t('model_access.row_only_one', { account: only })}</span>
                    </span>
                  ) : served ? (
                    <span className={styles.servedCount}>
                      {t('model_access.row_served_count', { count: row.servedBy.length })}
                    </span>
                  ) : (
                    <span className={styles.notServed}>{t('model_access.row_none')}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
