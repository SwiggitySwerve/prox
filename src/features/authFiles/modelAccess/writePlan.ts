/**
 * Turns one toggle intent into the exact list writes it needs, before anything is written.
 *
 * Because an account's own list REPLACES the provider list (accessRule.ts), "disable model X
 * everywhere" must write the provider list AND every account list; editing an inheriting
 * account must choose between the provider list and a new account list, never implicitly.
 */
import {
  normalizeExcludedRules,
  toggleExcludedRule,
} from '@/components/excludedModels/excludedModelRules';
import { blockingRule, followsProviderList, sameRuleSet } from './accessRule';
import {
  buildMatrix,
  modelUnion,
  type AccountAccess,
  type CellKind,
  type ModelAccessInventory,
} from './resolve';

export type ListTarget = { kind: 'provider' } | { kind: 'account'; name: string };

export interface ListWrite {
  target: ListTarget;
  /** The list the preview was built on; the executor refuses to write if the hub differs. */
  before: string[] | null;
  /** null = remove the list (provider entry deleted; account follows the provider list). */
  after: string[] | null;
}

export type WriteIntent =
  /** (a) one model on one account. `mode` is required when the account inherits. */
  | { type: 'account-model'; account: string; model: string; exclude: boolean; mode?: InheritMode }
  /** (b) one model on every account of the provider. */
  | { type: 'model-everywhere'; model: string; exclude: boolean }
  /** (c) one account across every model. */
  | { type: 'account-all'; account: string; exclude: boolean }
  /** (d) the provider default for one model. */
  | { type: 'provider-model'; model: string; exclude: boolean }
  /** Replace one list as edited (rules editor). */
  | { type: 'replace-list'; target: ListTarget; rules: string[] };

/** Editing an inheriting account: change the provider list, or give the account its own list. */
export type InheritMode = 'provider' | 'own';

export type PlanNotice =
  /** The provider list changes for these accounts too (they inherit it). */
  | { code: 'provider-affects'; accounts: string[] }
  /** These accounts have their own list and will NOT follow a provider-list change. */
  | { code: 'provider-ignored-by'; accounts: string[] }
  /** The account gets a list of its own and stops following the provider list. */
  | { code: 'stops-inheriting'; account: string }
  /** The account's list becomes empty, so it follows the provider list again. */
  | { code: 'starts-inheriting'; account: string; stillExcluded: string[] }
  /** The account cannot serve the model: an empty own list means "inherit" (backend rule). */
  | { code: 'cannot-override-provider'; account: string; model: string }
  /** These accounts' lists could not be read; the plan cannot be applied safely. */
  | { code: 'unreadable'; accounts: string[] }
  /** Nothing to write: the lists already say this. */
  | { code: 'no-change' };

export interface BlockedTarget {
  target: ListTarget;
  /** The wildcard rule that would still exclude the model after this plan. */
  rule: string;
}

export interface CellChange {
  account: string;
  model: string;
  from: CellKind;
  to: CellKind;
}

export interface WritePlan {
  intent: WriteIntent;
  writes: ListWrite[];
  blocked: BlockedTarget[];
  notices: PlanNotice[];
  changes: CellChange[];
  /** False when a write would be unsafe (unreadable lists) or there is nothing to write. */
  canApply: boolean;
}

export class InheritChoiceRequiredError extends Error {
  constructor(readonly account: string) {
    super(`Account ${account} follows the provider list: choose 'provider' or 'own'`);
    this.name = 'InheritChoiceRequiredError';
  }
}

const findAccount = (inventory: ModelAccessInventory, name: string): AccountAccess => {
  const account = inventory.accounts.find((item) => item.name === name);
  if (!account) throw new Error(`Unknown account: ${name}`);
  return account;
};

const ownRules = (account: AccountAccess): string[] | null =>
  account.ownList.status === 'known' ? account.ownList.rules : null;

const hasOwnList = (account: AccountAccess) =>
  account.ownList.status === 'known' && !followsProviderList(account.ownList.rules);

const inherits = (account: AccountAccess) =>
  account.ownList.status === 'known' && followsProviderList(account.ownList.rules);

const asList = (rules: string[]): string[] | null => {
  const normalized = normalizeExcludedRules(rules);
  return normalized.length > 0 ? normalized : null;
};

/** Does this intent need the provider-or-own choice first? */
export function needsInheritChoice(inventory: ModelAccessInventory, intent: WriteIntent): boolean {
  if (intent.type !== 'account-model' || intent.mode) return false;
  return inherits(findAccount(inventory, intent.account));
}

type Draft = { writes: ListWrite[]; blocked: BlockedTarget[]; notices: PlanNotice[] };

/** Add `model` to, or remove its exact rule from, one list; report a wildcard that still blocks. */
function editList(
  draft: Draft,
  target: ListTarget,
  before: string[] | null,
  model: string,
  exclude: boolean
): void {
  const current = before ?? [];
  if (exclude) {
    if (blockingRule(current, model)) return; // already excluded by this list
    draft.writes.push({ target, before, after: asList([...current, model]) });
    return;
  }
  const after = toggleExcludedRule(current, model, false);
  const still = blockingRule(after, model);
  if (still?.wildcard) {
    draft.blocked.push({ target, rule: still.rule });
    return;
  }
  if (!sameRuleSet(after, current)) draft.writes.push({ target, before, after: asList(after) });
}

const inheritingNames = (inventory: ModelAccessInventory) =>
  inventory.accounts.filter(inherits).map((account) => account.name);
const ownListNames = (inventory: ModelAccessInventory) =>
  inventory.accounts.filter(hasOwnList).map((account) => account.name);
const unreadableNames = (inventory: ModelAccessInventory) =>
  inventory.accounts
    .filter((account) => account.ownList.status !== 'known')
    .map((account) => account.name);

/** The inventory as it would be after the writes, with access assumed where the hub cannot say. */
export function applyWrites(
  inventory: ModelAccessInventory,
  writes: ListWrite[]
): ModelAccessInventory {
  const before = buildMatrix(inventory);
  let providerList = inventory.providerList;
  const accountLists = new Map<string, string[] | null>();
  for (const write of writes) {
    if (write.target.kind === 'provider') providerList = write.after ?? [];
    else accountLists.set(write.target.name, write.after);
  }
  return {
    ...inventory,
    providerList,
    accounts: inventory.accounts.map((account) => {
      // /credentials/models is post-exclusion, so a model excluded today has unknown access.
      // Assume the account could serve it once unblocked; the re-read after saving confirms.
      const blockedToday = before
        .filter((row) => {
          const kind = row.cells[account.name]?.kind;
          return kind === 'excluded-own' || kind === 'excluded-provider' || kind === 'wildcard';
        })
        .map((row) => row.model);
      const reported =
        account.reported.status === 'known'
          ? { status: 'known' as const, ids: [...account.reported.ids, ...blockedToday] }
          : account.reported;
      return accountLists.has(account.name)
        ? {
            ...account,
            ownList: { status: 'known', rules: accountLists.get(account.name) ?? null },
            reported,
          }
        : { ...account, reported };
    }),
  };
}

export function diffCells(before: ModelAccessInventory, after: ModelAccessInventory): CellChange[] {
  const afterRows = new Map(buildMatrix(after).map((row) => [row.model.toLowerCase(), row]));
  const changes: CellChange[] = [];
  for (const row of buildMatrix(before)) {
    const next = afterRows.get(row.model.toLowerCase());
    if (!next) continue;
    for (const account of before.accounts) {
      const from = row.cells[account.name]?.kind;
      const to = next.cells[account.name]?.kind;
      if (from && to && from !== to)
        changes.push({ account: account.name, model: row.model, from, to });
    }
  }
  return changes;
}

export function buildWritePlan(inventory: ModelAccessInventory, intent: WriteIntent): WritePlan {
  const draft: Draft = { writes: [], blocked: [], notices: [] };
  const provider: ListTarget = { kind: 'provider' };
  const providerBefore = inventory.providerList.length > 0 ? [...inventory.providerList] : null;
  let requiresAllReadable = false;

  switch (intent.type) {
    case 'account-model': {
      const account = findAccount(inventory, intent.account);
      if (account.ownList.status !== 'known') {
        draft.notices.push({ code: 'unreadable', accounts: [account.name] });
        break;
      }
      const target: ListTarget = { kind: 'account', name: account.name };
      if (hasOwnList(account)) {
        const before = ownRules(account);
        editList(draft, target, before, intent.model, intent.exclude);
        const write = draft.writes[0];
        if (write && write.after === null) {
          draft.notices.push({
            code: 'starts-inheriting',
            account: account.name,
            stillExcluded: modelUnion(inventory).filter((id) =>
              blockingRule(inventory.providerList, id)
            ),
          });
        }
        break;
      }
      if (!intent.mode) throw new InheritChoiceRequiredError(account.name);
      if (intent.mode === 'provider') {
        editList(draft, provider, providerBefore, intent.model, intent.exclude);
        requiresAllReadable = true;
        if (draft.writes.length > 0) {
          draft.notices.push({ code: 'provider-affects', accounts: inheritingNames(inventory) });
          const ignoring = ownListNames(inventory);
          if (ignoring.length > 0)
            draft.notices.push({ code: 'provider-ignored-by', accounts: ignoring });
        }
        break;
      }
      // mode 'own': a copy of the provider list plus the change.
      const copy = intent.exclude
        ? [...inventory.providerList, intent.model]
        : toggleExcludedRule(inventory.providerList, intent.model, false);
      const still = blockingRule(copy, intent.model);
      if (!intent.exclude && still?.wildcard) {
        draft.blocked.push({ target, rule: still.rule });
        break;
      }
      const after = asList(copy);
      if (after === null) {
        // An empty own list means "inherit", which would leave the model excluded.
        draft.notices.push({
          code: 'cannot-override-provider',
          account: account.name,
          model: intent.model,
        });
        break;
      }
      if (intent.exclude && blockingRule(inventory.providerList, intent.model)) break;
      draft.writes.push({ target, before: null, after });
      draft.notices.push({ code: 'stops-inheriting', account: account.name });
      break;
    }
    case 'provider-model': {
      requiresAllReadable = true;
      editList(draft, provider, providerBefore, intent.model, intent.exclude);
      if (draft.writes.length > 0) {
        draft.notices.push({ code: 'provider-affects', accounts: inheritingNames(inventory) });
        const ignoring = ownListNames(inventory);
        if (ignoring.length > 0)
          draft.notices.push({ code: 'provider-ignored-by', accounts: ignoring });
      }
      break;
    }
    case 'model-everywhere': {
      requiresAllReadable = true;
      // Account lists first, then the provider list: the executor keeps this order.
      for (const account of inventory.accounts.filter(hasOwnList)) {
        editList(
          draft,
          { kind: 'account', name: account.name },
          ownRules(account),
          intent.model,
          intent.exclude
        );
      }
      editList(draft, provider, providerBefore, intent.model, intent.exclude);
      break;
    }
    case 'account-all': {
      const account = findAccount(inventory, intent.account);
      if (account.ownList.status !== 'known') {
        draft.notices.push({ code: 'unreadable', accounts: [account.name] });
        break;
      }
      const target: ListTarget = { kind: 'account', name: account.name };
      const before = ownRules(account);
      if (intent.exclude) {
        const after = asList(modelUnion(inventory));
        if (after && !sameRuleSet(before, after)) {
          draft.writes.push({ target, before, after });
          if (!hasOwnList(account))
            draft.notices.push({ code: 'stops-inheriting', account: account.name });
        }
      } else if (hasOwnList(account)) {
        draft.writes.push({ target, before, after: null });
        draft.notices.push({
          code: 'starts-inheriting',
          account: account.name,
          stillExcluded: modelUnion(inventory).filter((id) =>
            blockingRule(inventory.providerList, id)
          ),
        });
      }
      break;
    }
    case 'replace-list': {
      const before =
        intent.target.kind === 'provider'
          ? providerBefore
          : ownRules(findAccount(inventory, intent.target.name));
      if (intent.target.kind === 'account') {
        const account = findAccount(inventory, intent.target.name);
        if (account.ownList.status !== 'known') {
          draft.notices.push({ code: 'unreadable', accounts: [account.name] });
          break;
        }
      } else {
        requiresAllReadable = true;
      }
      const after = asList(intent.rules);
      if (!sameRuleSet(before, after)) draft.writes.push({ target: intent.target, before, after });
      if (intent.target.kind === 'provider' && draft.writes.length > 0) {
        draft.notices.push({ code: 'provider-affects', accounts: inheritingNames(inventory) });
        const ignoring = ownListNames(inventory);
        if (ignoring.length > 0)
          draft.notices.push({ code: 'provider-ignored-by', accounts: ignoring });
      }
      break;
    }
    default: {
      const unreachable: never = intent;
      throw new Error(`Unhandled write intent: ${JSON.stringify(unreachable)}`);
    }
  }

  const unreadable = requiresAllReadable ? unreadableNames(inventory) : [];
  if (unreadable.length > 0) draft.notices.push({ code: 'unreadable', accounts: unreadable });
  const hasUnreadable = draft.notices.some((notice) => notice.code === 'unreadable');
  if (draft.writes.length === 0 && draft.blocked.length === 0 && !hasUnreadable) {
    if (!draft.notices.some((notice) => notice.code === 'cannot-override-provider')) {
      draft.notices.push({ code: 'no-change' });
    }
  }
  const changes =
    draft.writes.length > 0 ? diffCells(inventory, applyWrites(inventory, draft.writes)) : [];
  return {
    intent,
    writes: draft.writes,
    blocked: draft.blocked,
    notices: draft.notices,
    changes,
    canApply: draft.writes.length > 0 && !hasUnreadable,
  };
}
