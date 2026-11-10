/** Pure view helpers for the Models screen: filters, counts and labels. */
import { isNamedProvider, providerOfCredential } from '@/features/authFiles/credentialFacts';
import type { AuthFileItem } from '@/types';
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

/** What one hub section shows: model columns, how many of them are served, account rows. */
export type VisibleCounts = { models: number; served: number; accounts: number };

export function sumCounts(counts: readonly VisibleCounts[]): VisibleCounts {
  return counts.reduce(
    (sum, item) => ({
      models: sum.models + item.models,
      served: sum.served + item.served,
      accounts: sum.accounts + item.accounts,
    }),
    { models: 0, served: 0, accounts: 0 }
  );
}

/**
 * Row groups of the access table, in display order. `follows`: no list of its own (runtime
 * credentials included); `own`: its own list replaces the provider list; `unknown`: its list could
 * not be read; `off`: disabled, whatever its list says.
 */
export const ACCOUNT_GROUPS = ['follows', 'own', 'unknown', 'off'] as const;
export type AccountGroupKey = (typeof ACCOUNT_GROUPS)[number];

export function accountGroupOf(account: AccountAccess): AccountGroupKey {
  if (account.disabled) return 'off';
  const kind = accountListKind(account);
  return kind === 'own' ? 'own' : kind === 'unknown' ? 'unknown' : 'follows';
}

/** The non-empty groups, each keeping the inventory order of its accounts. */
export function groupAccounts(
  accounts: readonly AccountAccess[]
): Array<{ key: AccountGroupKey; accounts: AccountAccess[] }> {
  return ACCOUNT_GROUPS.map((key) => ({
    key,
    accounts: accounts.filter((account) => accountGroupOf(account) === key),
  })).filter((group) => group.accounts.length > 0);
}

/** One hub's credential files as the page sees them; undefined until they have been read. */
export type HubFiles = { id: string; files: readonly AuthFileItem[] | undefined };

/**
 * Credentials per named provider over the hubs in scope. `complete` is false while any of them has
 * not been read (or its read failed): a provider only that hub has may still exist.
 */
export function providerCountsAcross(hubs: readonly HubFiles[]): {
  counts: Record<string, number>;
  complete: boolean;
} {
  const counts: Record<string, number> = {};
  let complete = true;
  for (const hub of hubs) {
    if (!hub.files) {
      complete = false;
      continue;
    }
    for (const file of hub.files) {
      const key = providerOfCredential(file);
      if (isNamedProvider(key)) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return { counts, complete };
}

/**
 * The provider tab shown across hubs. With every hub read, resolveProviderParam decides. While one
 * is unknown a named request stands (that hub may have it); without one, the first provider a
 * known hub has is shown, without writing the URL.
 */
export function resolveProviderAcross(
  requested: string | null,
  providers: readonly string[],
  complete: boolean
): { provider: string; param: string | null } {
  if (complete) return resolveProviderParam(requested, providers);
  const standing = resolveProviderParam(requested, undefined);
  if (standing.provider) return standing;
  return { provider: providers[0] ?? '', param: null };
}

/** Hubs that get a section for a provider: those that have it, and those not read yet. */
export function hubsForProvider(hubs: readonly HubFiles[], provider: string): string[] {
  if (!provider) return [];
  return hubs
    .filter(
      (hub) => !hub.files || hub.files.some((file) => providerOfCredential(file) === provider)
    )
    .map((hub) => hub.id);
}

/** `?source=` as a filter: a known hub when there is more than one, otherwise every hub (null). */
export function resolveSourceScope(requested: string | null, hubIds: readonly string[]) {
  return requested && hubIds.length > 1 && hubIds.includes(requested) ? requested : null;
}

/**
 * The hub whose Rules view opens `?list=`: the hub named by `?source=`, else the first hub (in
 * section order) that has that account. A provider list key, or an account no read hub has, has no
 * owner; every section then shows its provider list.
 */
export function listOwner(
  list: string | null,
  source: string | null,
  hubs: readonly HubFiles[]
): string | null {
  if (!list) return null;
  if (source && hubs.some((hub) => hub.id === source)) return source;
  const target = targetOfListKey(list);
  if (target.kind === 'provider') return null;
  return hubs.find((hub) => hub.files?.some((file) => file.name === target.name))?.id ?? null;
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
