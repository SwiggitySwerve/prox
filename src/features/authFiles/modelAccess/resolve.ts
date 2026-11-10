/**
 * Effective model access per account: a pure function of the provider list, the account's own
 * list, its disabled flag and the models the hub reports for it. Every cell of the Models screen
 * and every write-plan preview is computed here, so the screen can never disagree with itself.
 */
import { normalizeExcludedRules } from '@/components/excludedModels/excludedModelRules';
import type { OAuthModelAliasEntry } from '@/types';
import { blockingRule, rulesInEffect, type RuleSource } from './accessRule';

/** The account's own list as read from its credential file. `rules: null` = no list (inherits). */
export type OwnListRead =
  { status: 'known'; rules: string[] | null } | { status: 'unknown'; message: string };

/** `/credentials/models`: what the hub registered for the account, already after exclusions. */
export type ReportedRead =
  { status: 'known'; ids: string[] } | { status: 'unknown'; message: string };

/**
 * `file`: an OAuth credential file; its own list or the provider list decides, and both are
 * editable here. `runtime`: a credential the hub holds in memory only (`runtime_only`, e.g. an
 * AI Studio websocket channel, service_auth.go:376). It has no file, so it cannot have a list of
 * its own and always follows the provider list; its column is read-only. Config API keys are a
 * different thing: the hub does not list them as credentials at all (auth_files.go:654-662) and
 * the provider list never applies to them (service_models.go:645-655).
 */
export type AccountKind = 'file' | 'runtime';

export interface AccountAccess {
  /** Credential file name (or runtime id): the identity every read and write uses. */
  name: string;
  kind: AccountKind;
  /** Display label (email or file name); never an account/API-key field. */
  label: string;
  disabled: boolean;
  ownList: OwnListRead;
  reported: ReportedRead;
}

export interface ModelAccessInventory {
  provider: string;
  providerList: string[];
  catalog: string[];
  aliases: OAuthModelAliasEntry[];
  accounts: AccountAccess[];
}

/**
 * One cell. `drift` = the lists and the hub disagree (it still reports a model the lists exclude),
 * which is expected for a moment after a write while the hub re-registers the account.
 */
export type CellState =
  | { kind: 'served'; via: RuleSource }
  | { kind: 'excluded-own'; rule: string; drift: boolean }
  | { kind: 'excluded-provider'; rule: string; drift: boolean }
  | { kind: 'wildcard'; rule: string; list: 'account' | 'provider'; drift: boolean }
  | { kind: 'disabled' }
  | { kind: 'no-access' }
  | { kind: 'unknown' };

export type CellKind = CellState['kind'];

export const CELL_KINDS: readonly CellKind[] = [
  'served',
  'excluded-own',
  'excluded-provider',
  'wildcard',
  'disabled',
  'no-access',
  'unknown',
];

/** Only exact-rule exclusions and served cells can be toggled; wildcards are edited as rules. */
export const isCellToggleable = (cell: CellState): boolean =>
  cell.kind === 'served' || cell.kind === 'excluded-own' || cell.kind === 'excluded-provider';

/** A runtime credential has no file to hold a list of its own: only the provider list moves it. */
export const isAccountEditable = (account: AccountAccess): boolean => account.kind === 'file';

export const isCellExcluded = (cell: CellState): boolean =>
  cell.kind === 'excluded-own' || cell.kind === 'excluded-provider' || cell.kind === 'wildcard';

const lower = (value: string) => value.trim().toLowerCase();

export function resolveCell(
  providerList: readonly string[],
  account: AccountAccess,
  modelId: string
): CellState {
  if (account.disabled) return { kind: 'disabled' };
  if (account.ownList.status !== 'known') return { kind: 'unknown' };
  const { source, rules } = rulesInEffect(providerList, account.ownList.rules);
  const reported =
    account.reported.status === 'known'
      ? account.reported.ids.some((id) => lower(id) === lower(modelId))
      : null;
  const match = blockingRule(rules, modelId);
  if (match) {
    const drift = reported === true;
    // `source` is never 'none' when a rule matched.
    const list = source === 'account' ? 'account' : 'provider';
    if (match.wildcard) return { kind: 'wildcard', rule: match.rule, list, drift };
    return list === 'account'
      ? { kind: 'excluded-own', rule: match.rule, drift }
      : { kind: 'excluded-provider', rule: match.rule, drift };
  }
  if (reported === null) return { kind: 'unknown' };
  return reported ? { kind: 'served', via: source } : { kind: 'no-access' };
}

export type ProviderCell =
  { excluded: false } | { excluded: true; rule: string; wildcard: boolean };

export function resolveProviderCell(
  providerList: readonly string[],
  modelId: string
): ProviderCell {
  const match = blockingRule(normalizeExcludedRules(providerList), modelId);
  return match ? { excluded: true, ...match } : { excluded: false };
}

/**
 * Every model worth a row: the catalog in its order, then models an account reports that the
 * catalog lacks, then exact rules naming models neither knows (retired ids keep a visible row).
 */
export function modelUnion(inventory: ModelAccessInventory): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(lower(trimmed))) return;
    seen.add(lower(trimmed));
    out.push(trimmed);
  };
  inventory.catalog.forEach(add);
  const extra: string[] = [];
  for (const account of inventory.accounts) {
    if (account.reported.status === 'known') extra.push(...account.reported.ids);
  }
  const ruleOnly: string[] = [...inventory.providerList];
  for (const account of inventory.accounts) {
    if (account.ownList.status === 'known') ruleOnly.push(...(account.ownList.rules ?? []));
  }
  [...extra].sort((a, b) => a.localeCompare(b)).forEach(add);
  ruleOnly
    .filter((rule) => !rule.includes('*'))
    .sort((a, b) => a.localeCompare(b))
    .forEach(add);
  return out;
}

export interface MatrixRow {
  model: string;
  inCatalog: boolean;
  provider: ProviderCell;
  cells: Record<string, CellState>;
  /** Names of the accounts that serve this model. */
  servedBy: string[];
  /** Aliases the hub publishes for this upstream model. */
  aliases: string[];
}

export function buildMatrix(inventory: ModelAccessInventory): MatrixRow[] {
  const catalog = new Set(inventory.catalog.map(lower));
  return modelUnion(inventory).map((model) => {
    const cells: Record<string, CellState> = {};
    const servedBy: string[] = [];
    for (const account of inventory.accounts) {
      const cell = resolveCell(inventory.providerList, account, model);
      cells[account.name] = cell;
      if (cell.kind === 'served') servedBy.push(account.name);
    }
    return {
      model,
      inCatalog: catalog.has(lower(model)),
      provider: resolveProviderCell(inventory.providerList, model),
      cells,
      servedBy,
      aliases: inventory.aliases
        .filter((entry) => lower(entry.name) === lower(model))
        .map((entry) => entry.alias),
    };
  });
}
