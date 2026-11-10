/** Pure view helpers for the Models screen: filters, counts and labels. */
import {
  isCellExcluded,
  type ListTarget,
  type ListWrite,
  type AccountAccess,
  type CellState,
  type MatrixRow,
} from '@/features/authFiles/modelAccess';

/** Served = at least one account serves the model; not served = no account does. */
export const MODEL_VIEWS = ['all', 'served', 'excluded'] as const;
export type ModelView = (typeof MODEL_VIEWS)[number];
export const isModelView = (value: unknown): value is ModelView =>
  typeof value === 'string' && (MODEL_VIEWS as readonly string[]).includes(value);

export const MODELS_TABS = ['access', 'rules', 'aliases'] as const;
export type ModelsTab = (typeof MODELS_TABS)[number];
export const isModelsTab = (value: unknown): value is ModelsTab =>
  typeof value === 'string' && (MODELS_TABS as readonly string[]).includes(value);

const includes = (value: string, query: string) =>
  value.toLowerCase().includes(query.trim().toLowerCase());

export function filterRows(rows: MatrixRow[], modelQuery: string, view: ModelView): MatrixRow[] {
  return rows.filter((row) => {
    if (view === 'served' && row.servedBy.length === 0) return false;
    if (view === 'excluded' && row.servedBy.length > 0) return false;
    if (!modelQuery.trim()) return true;
    return (
      includes(row.model, modelQuery) || row.aliases.some((alias) => includes(alias, modelQuery))
    );
  });
}

export function filterAccounts(accounts: AccountAccess[], query: string): AccountAccess[] {
  if (!query.trim()) return accounts;
  return accounts.filter(
    (account) => includes(account.label, query) || includes(account.name, query)
  );
}

export function countServed(rows: MatrixRow[]) {
  return { served: rows.filter((row) => row.servedBy.length > 0).length, total: rows.length };
}

/** i18n key (under model_access.) for a cell's state. */
export function cellLabelKey(cell: CellState): string {
  switch (cell.kind) {
    case 'served':
      return 'cell_served';
    case 'excluded-own':
      return 'cell_excluded_own';
    case 'excluded-provider':
      return 'cell_excluded_provider';
    case 'wildcard':
      return 'cell_wildcard';
    case 'disabled':
      return 'cell_disabled';
    case 'no-access':
      return 'cell_no_access';
    case 'not-served':
      return 'cell_not_served';
    case 'unknown':
      return 'cell_unknown';
    default: {
      const unreachable: never = cell;
      throw new Error(`Unhandled cell ${JSON.stringify(unreachable)}`);
    }
  }
}

export const cellRule = (cell: CellState): string | null =>
  cell.kind === 'excluded-own' || cell.kind === 'excluded-provider' || cell.kind === 'wildcard'
    ? cell.rule
    : null;

export const cellDrift = (cell: CellState): boolean =>
  (cell.kind === 'excluded-own' || cell.kind === 'excluded-provider' || cell.kind === 'wildcard') &&
  cell.drift;

/** Toggling a toggleable cell flips it: an excluded cell is served, a served one excluded. */
export const nextExcludeFor = (cell: CellState): boolean => !isCellExcluded(cell);

/** `runtime` = a config API key: read-only here, edited in AI Providers. */
export type AccountListKind = 'own' | 'inherits' | 'unknown' | 'runtime';
export const accountListKind = (account: AccountAccess): AccountListKind =>
  account.kind === 'runtime'
    ? 'runtime'
    : account.ownList.status !== 'known'
      ? 'unknown'
      : account.ownList.rules && account.ownList.rules.some((rule) => rule.trim())
        ? 'own'
        : 'inherits';

const lowerRule = (value: string) => value.toLowerCase();

/** Rules added and removed between two versions of a list. */
export function listDiff(write: Pick<ListWrite, 'before' | 'after'>) {
  const before = write.before ?? [];
  const after = write.after ?? [];
  return {
    added: after.filter((rule) => !before.some((item) => lowerRule(item) === lowerRule(rule))),
    removed: before.filter((rule) => !after.some((item) => lowerRule(item) === lowerRule(rule))),
  };
}

/** Rules-tab list key in the URL: `provider` or `account:<file name>`. */
export const listKeyOf = (target: ListTarget) =>
  target.kind === 'provider' ? 'provider' : `account:${target.name}`;

export function targetOfListKey(key: string): ListTarget {
  return key.startsWith('account:')
    ? { kind: 'account', name: key.slice(8) }
    : { kind: 'provider' };
}

/** Old editor links (`?source=` and `?provider=`) open the matching tab of the Models screen. */
export function legacyModelsTarget(search: string, tab: ModelsTab): string {
  const params = new URLSearchParams(search);
  const next = new URLSearchParams();
  const source = params.get('source');
  const provider = params.get('provider');
  if (source) next.set('source', source);
  if (provider) next.set('provider', provider.trim().toLowerCase());
  next.set('tab', tab);
  return `/auth-files/models?${next.toString()}`;
}
