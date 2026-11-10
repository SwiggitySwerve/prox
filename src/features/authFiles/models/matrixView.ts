/** Pure view helpers for the Models screen: filters, counts and labels. */
import { isNamedProvider } from '@/features/authFiles/credentialFacts';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
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
    case 'unknown':
      return 'cell_unknown';
    default: {
      const unreachable: never = cell;
      throw new Error(`Unhandled cell ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * i18n key (under model_access.) for a cell's short visible text. The full sentence
 * (cellLabelKey) stays in the cell's aria-label and title. A wildcard shows a lock and its rule.
 */
export function cellShortKey(cell: CellState): string {
  switch (cell.kind) {
    case 'served':
      return 'cell_short_served';
    case 'excluded-own':
      return 'cell_short_excluded_own';
    case 'excluded-provider':
      return 'cell_short_excluded_provider';
    case 'wildcard':
      return 'cell_short_wildcard';
    case 'disabled':
      return 'cell_short_disabled';
    case 'no-access':
      return 'cell_short_no_access';
    case 'unknown':
      return 'cell_short_unknown';
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

/** `runtime` = held in memory by the hub, no file: follows the provider list, read-only here. */
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

/**
 * A Rules-tab list key that names an existing credential file, or `provider`. A link to an
 * account that is gone (or to a read-only API key) falls back to the provider list.
 */
export function resolveListKey(key: string | null, accounts: readonly AccountAccess[]): string {
  const target = targetOfListKey(key ?? 'provider');
  if (target.kind === 'provider') return 'provider';
  return accounts.some((account) => account.kind === 'file' && account.name === target.name)
    ? listKeyOf(target)
    : 'provider';
}

/** A list's value for "did the saved list change": order-insensitive, whitespace-trimmed. */
export const listSignature = (rules: readonly string[]): string =>
  rules
    .map((rule) => rule.trim())
    .filter(Boolean)
    .sort()
    .join('\n');

/**
 * The provider the screen shows and the `?provider=` value the URL should carry.
 *
 * The requested key is normalised the way credentials are (`grok` -> `xai`), so the screen reads
 * and writes the same provider. While the credentials are unknown (`providers` undefined) the
 * request stands. Once they are known, a provider this source has no credentials for is replaced
 * by the first one it has (or none); an absent request shows the first without writing the URL.
 */
export function resolveProviderParam(
  requested: string | null,
  providers: readonly string[] | undefined
): { provider: string; param: string | null } {
  const raw = requested?.trim() ?? '';
  const key = raw ? normalizeOAuthProviderKey(raw) : '';
  const named = isNamedProvider(key) ? key : '';
  if (!providers) return { provider: named, param: named || null };
  if (!raw) return { provider: providers[0] ?? '', param: null };
  if (named && providers.includes(named)) return { provider: named, param: named };
  return { provider: providers[0] ?? '', param: providers[0] ?? null };
}

/** What a row's action does: exclude a served model, include it, or edit the rule locking it. */
export type RowAction =
  { kind: 'exclude' } | { kind: 'include' } | { kind: 'edit-rule'; target: ListTarget };

/**
 * "Include everywhere" can only remove exact rules. When every account that could serve the model
 * is held back by a wildcard instead, offer the rule: its list (provider or own) opens on Rules.
 */
export function rowActionFor(row: MatrixRow): RowAction {
  if (row.servedBy.length > 0) return { kind: 'exclude' };
  let lock: ListTarget | null = null;
  // Cells are keyed by every account of the provider, in inventory order. Runtime credentials
  // never resolve to an exclusion, and disabled accounts resolve to 'disabled'.
  for (const [name, cell] of Object.entries(row.cells)) {
    if (cell.kind === 'excluded-own' || cell.kind === 'excluded-provider') {
      return { kind: 'include' };
    }
    if (cell.kind === 'wildcard' && !lock) {
      lock = cell.list === 'provider' ? { kind: 'provider' } : { kind: 'account', name };
    }
  }
  return lock ? { kind: 'edit-rule', target: lock } : { kind: 'include' };
}

/** Labels two or more accounts share; their columns also show the file name. */
export function sharedLabels(accounts: readonly AccountAccess[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.label)) shared.add(account.label);
    seen.add(account.label);
  }
  return shared;
}

/** Old editor links (`?source=` and `?provider=`) open the matching tab of the Models screen. */
export function legacyModelsTarget(search: string, tab: ModelsTab): string {
  const params = new URLSearchParams(search);
  const next = new URLSearchParams();
  const source = params.get('source');
  const provider = params.get('provider');
  if (source) next.set('source', source);
  if (provider) next.set('provider', normalizeOAuthProviderKey(provider));
  next.set('tab', tab);
  return `/auth-files/models?${next.toString()}`;
}
