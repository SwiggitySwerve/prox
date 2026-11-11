/**
 * The on/off grid of the Models screen: staged switches, and the list writes Prox computes for them.
 *
 * Every cell means "this account serves this model". The user never chooses a list: Prox works out
 * which lists to write from the result they asked for (accessRule.ts has the backend rule):
 *
 * - The provider list is the shared default. Every account without a list of its own follows it,
 *   and a runtime credential (no file) always does.
 * - An account that differs from the shared default gets its own list; one that matches it again
 *   loses its list. A list whose effect does not change is not written.
 * - A file account cannot differ by having nothing off: an empty own list means "follow".
 *
 * Among the shared defaults that can express every account's switches, the one needing the fewest
 * writes wins (ties keep the current default; planAccessWrites says why that search is exact). Wildcards are kept while every model they match
 * stays off; turning one of those models on replaces the wildcard, in that list only, with the
 * known models it matched minus the ones turned on.
 *
 * Models an account cannot get (not reported and not excluded) are not switches: they are left to
 * whatever list the account ends up with.
 */
import {
  isWildcardRule,
  matchesExcludedRule,
  normalizeExcludedRules,
} from '@/components/excludedModels/excludedModelRules';
import { blockingRule, rulesInEffect } from './accessRule';
import { modelUnion, type AccountAccess, type ModelAccessInventory } from './resolve';
import type { ListGuard, ListTarget, ListWrite } from './writePlan';

/** Staged switches: account name -> model key (lower case) -> on. Only real changes are kept. */
export type AccessOverrides = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

export interface AccessChange {
  account: string;
  model: string;
  on: boolean;
}

export type AccessCell =
  /** `changed`: staged, not saved yet. */
  | { kind: 'switch'; on: boolean; changed: boolean }
  /** The account cannot get this model at all. */
  | { kind: 'none' }
  /** The account's settings could not be read, so its state is not known. */
  | { kind: 'unknown' };

export type AccessBlock =
  /** The change moves the shared default, and these accounts' lists could not be read. */
  | { code: 'unreadable'; accounts: string[] }
  /** Runtime credentials all follow the shared default, so they cannot differ from each other. */
  | { code: 'runtime-differ'; accounts: string[] }
  /** `account` wants every model on while the runtime credentials keep some off. */
  | { code: 'all-on'; account: string; runtime: string[] };

export interface WildcardExpansion {
  target: ListTarget;
  rule: string;
  /** The known models it matched that stay off; they replace the wildcard. */
  replacedBy: string[];
  /** The models turned on. */
  unblocked: string[];
}

export type AccessPlan =
  | { status: 'none' }
  | { status: 'blocked'; block: AccessBlock }
  | { status: 'ready'; writes: ListWrite[]; guards: ListGuard[]; expansions: WildcardExpansion[] };

const key = (model: string) => model.trim().toLowerCase();

const known = (account: AccountAccess) => account.ownList.status === 'known';

const ownRulesOf = (account: AccountAccess): string[] =>
  account.kind === 'file' && account.ownList.status === 'known'
    ? normalizeExcludedRules(account.ownList.rules ?? [])
    : [];

const blockedBy = (rules: readonly string[], model: string) => blockingRule(rules, model) !== null;

/** Off today, from the lists (not from what the hub reports). */
const offNow = (inventory: ModelAccessInventory, account: AccountAccess, model: string) =>
  blockedBy(rulesInEffect(inventory.providerList, ownRulesOf(account)).rules, model);

/**
 * The model keys that are switches for this account: those it reports or the lists exclude. A
 * disabled account, or one whose models could not be read, has a switch for every model.
 */
function switchKeys(
  inventory: ModelAccessInventory,
  account: AccountAccess,
  models: readonly string[]
): Set<string> {
  if (!known(account)) return new Set();
  if (account.disabled || account.reported.status !== 'known') return new Set(models.map(key));
  const reported = new Set(account.reported.ids.map(key));
  return new Set(
    models.filter((model) => reported.has(key(model)) || offNow(inventory, account, model)).map(key)
  );
}

export function accessCell(
  inventory: ModelAccessInventory,
  overrides: AccessOverrides,
  account: AccountAccess,
  model: string
): AccessCell {
  if (!known(account)) return { kind: 'unknown' };
  if (!switchKeys(inventory, account, modelUnion(inventory)).has(key(model))) {
    return { kind: 'none' };
  }
  const staged = overrides[account.name]?.[key(model)];
  const current = !offNow(inventory, account, model);
  return { kind: 'switch', on: staged ?? current, changed: staged !== undefined };
}

/** Drop staged switches that equal the current state or are no longer switches. Same ref if none. */
export function pruneOverrides(
  inventory: ModelAccessInventory,
  overrides: AccessOverrides
): AccessOverrides {
  const models = modelUnion(inventory);
  const byKey = new Map(models.map((model) => [key(model), model]));
  let changed = false;
  const next: Record<string, Record<string, boolean>> = {};
  for (const [name, entries] of Object.entries(overrides)) {
    const account = inventory.accounts.find((item) => item.name === name);
    // Unreadable now (a failed re-read): nothing confirms the switches landed, so they stay.
    if (account && !known(account)) {
      next[name] = { ...entries };
      continue;
    }
    const switches = account ? switchKeys(inventory, account, models) : new Set<string>();
    for (const [modelKey, on] of Object.entries(entries)) {
      const model = byKey.get(modelKey);
      const keep =
        account && model && switches.has(modelKey) && on === offNow(inventory, account, model);
      if (!keep) {
        changed = true;
        continue;
      }
      (next[name] ??= {})[modelKey] = on;
    }
  }
  return changed ? next : overrides;
}

/** Stage switches; cells that are not switches are skipped, and a switch set back is unstaged. */
export function stageAccess(
  inventory: ModelAccessInventory,
  overrides: AccessOverrides,
  changes: readonly AccessChange[]
): AccessOverrides {
  const next: Record<string, Record<string, boolean>> = {};
  for (const [name, entries] of Object.entries(overrides)) next[name] = { ...entries };
  for (const change of changes) (next[change.account] ??= {})[key(change.model)] = change.on;
  return pruneOverrides(inventory, next);
}

/** The staged switches, in account order then model order. */
export function pendingAccessChanges(
  inventory: ModelAccessInventory,
  overrides: AccessOverrides
): AccessChange[] {
  const models = modelUnion(inventory);
  return inventory.accounts.flatMap((account) =>
    models.flatMap((model) => {
      const on = overrides[account.name]?.[key(model)];
      return on === undefined ? [] : [{ account: account.name, model, on }];
    })
  );
}

// ---------- computing the writes ----------

type Want = 'block' | 'allow' | 'any';

interface Desire {
  account: AccountAccess;
  /** Model keys that are switches for this account. */
  switches: Set<string>;
  /** Model keys the account should have off, among its switches. */
  off: Set<string>;
}

/**
 * Rewrite `base` so it blocks exactly the models wanted off ('any' = no preference): exact rules
 * for models wanted on go, wildcards that match a model wanted on are replaced by their other
 * matches, and models wanted off that nothing blocks yet are added.
 */
function rewriteList(
  base: readonly string[],
  models: readonly string[],
  want: (modelKey: string) => Want
): { rules: string[]; expansions: Array<Omit<WildcardExpansion, 'target'>> } {
  const rules: string[] = [];
  const expansions: Array<Omit<WildcardExpansion, 'target'>> = [];
  for (const rule of normalizeExcludedRules(base)) {
    const hits = models.filter((model) => matchesExcludedRule(rule, model));
    const unblocked = hits.filter((model) => want(key(model)) === 'allow');
    if (unblocked.length === 0) {
      rules.push(rule);
      continue;
    }
    if (!isWildcardRule(rule)) continue;
    const replacedBy = hits.filter((model) => want(key(model)) === 'block');
    rules.push(...replacedBy);
    expansions.push({ rule, replacedBy, unblocked });
  }
  for (const model of models) {
    if (want(key(model)) === 'block' && !blockedBy(rules, model)) rules.push(model);
  }
  return { rules: normalizeExcludedRules(rules), expansions };
}

const offSet = (rules: readonly string[], models: readonly string[]) =>
  new Set(models.filter((model) => blockedBy(rules, model)).map(key));

/** Same off-state on the given model keys. */
const agrees = (left: Set<string>, right: Set<string>, on: Iterable<string>) => {
  for (const item of on) if (left.has(item) !== right.has(item)) return false;
  return true;
};

const asList = (rules: string[]): string[] | null => (rules.length > 0 ? rules : null);

type Outcome =
  | { ok: true; writes: ListWrite[]; expansions: WildcardExpansion[] }
  | { ok: false; block: AccessBlock };

/** The writes that make every account match its desire, with `shared` as the provider default. */
function evaluate(
  inventory: ModelAccessInventory,
  models: readonly string[],
  desires: readonly Desire[],
  shared: Set<string>
): Outcome {
  const providerBefore = normalizeExcludedRules(inventory.providerList);
  const allKeys = models.map(key);
  const writes: ListWrite[] = [];
  const expansions: WildcardExpansion[] = [];
  const providerMoves = !agrees(shared, offSet(providerBefore, models), allKeys);
  if (providerMoves) {
    const next = rewriteList(providerBefore, models, (item) =>
      shared.has(item) ? 'block' : 'allow'
    );
    const target: ListTarget = { kind: 'provider' };
    writes.push({ target, before: asList(providerBefore), after: asList(next.rules) });
    expansions.push(...next.expansions.map((item) => ({ target, ...item })));
  }
  const runtime = desires.filter((desire) => desire.account.kind === 'runtime');
  for (const desire of desires) {
    const { account, switches, off } = desire;
    const matchesShared = agrees(shared, off, switches);
    if (account.kind === 'runtime') {
      if (!matchesShared) {
        return {
          ok: false,
          block: { code: 'runtime-differ', accounts: runtime.map((item) => item.account.name) },
        };
      }
      continue;
    }
    const own = ownRulesOf(account);
    const offToday = own.length > 0 ? offSet(own, models) : shared;
    if (agrees(offToday, off, switches)) continue;
    const target: ListTarget = { kind: 'account', name: account.name };
    if (matchesShared) {
      writes.push({ target, before: own, after: null });
      continue;
    }
    const next = rewriteList(own.length > 0 ? own : providerBefore, models, (item) =>
      !switches.has(item) ? 'any' : off.has(item) ? 'block' : 'allow'
    );
    if (next.rules.length === 0) {
      return {
        ok: false,
        block: {
          code: 'all-on',
          account: account.name,
          runtime: runtime.map((item) => item.account.name),
        },
      };
    }
    writes.push({ target, before: asList(own), after: next.rules });
    expansions.push(...next.expansions.map((item) => ({ target, ...item })));
  }
  return { ok: true, writes, expansions };
}

export function planAccessWrites(
  inventory: ModelAccessInventory,
  overrides: AccessOverrides
): AccessPlan {
  const pruned = pruneOverrides(inventory, overrides);
  if (Object.keys(pruned).length === 0) return { status: 'none' };
  const stagedUnread = inventory.accounts
    .filter((account) => !known(account) && pruned[account.name])
    .map((account) => account.name);
  if (stagedUnread.length > 0) {
    return { status: 'blocked', block: { code: 'unreadable', accounts: stagedUnread } };
  }
  const models = modelUnion(inventory);
  const allKeys = models.map(key);
  const desires: Desire[] = inventory.accounts.filter(known).map((account) => {
    const switches = switchKeys(inventory, account, models);
    const off = new Set(
      models
        .filter((model) => switches.has(key(model)))
        .filter(
          (model) => !(pruned[account.name]?.[key(model)] ?? !offNow(inventory, account, model))
        )
        .map(key)
    );
    return { account, switches, off };
  });
  const unreadable = inventory.accounts
    .filter((account) => !known(account))
    .map((account) => account.name);
  const sharedNow = offSet(normalizeExcludedRules(inventory.providerList), models);

  /*
   * The fewest writes, exactly. An account with its own list costs one write if that list does
   * not already give its switches and none if it does, whatever the provider list says; only the
   * accounts that follow the provider list depend on it. So the best provider list is the one the
   * largest set of followers agree on (minus one write if it has to change). Runtime credentials,
   * and any account that wants nothing off (an empty own list means "follow"), must agree with it.
   */
  const fits = (a: Desire, b: Desire) =>
    [...a.switches].every((item) => !b.switches.has(item) || a.off.has(item) === b.off.has(item));
  const shape = (group: readonly Desire[]) =>
    new Set(
      allKeys.filter((item) => {
        const owner = group.find((desire) => desire.switches.has(item));
        return owner ? owner.off.has(item) : sharedNow.has(item);
      })
    );
  const ownSatisfied = (desire: Desire) => {
    const own = ownRulesOf(desire.account);
    return own.length > 0 && agrees(offSet(own, models), desire.off, desire.switches);
  };
  const forced = desires.filter(
    (desire) =>
      desire.account.kind === 'runtime' || (desire.off.size === 0 && !ownSatisfied(desire))
  );
  for (const [index, a] of forced.entries()) {
    const clash = forced.slice(index + 1).find((b) => !fits(a, b));
    if (!clash) continue;
    const runtimeNames = desires
      .filter((desire) => desire.account.kind === 'runtime')
      .map((desire) => desire.account.name);
    const file = [a, clash].find((desire) => desire.account.kind === 'file');
    return {
      status: 'blocked',
      block: file
        ? { code: 'all-on', account: file.account.name, runtime: runtimeNames }
        : { code: 'runtime-differ', accounts: runtimeNames },
    };
  }
  const optional = desires.filter(
    (desire) =>
      desire.account.kind === 'file' &&
      ownRulesOf(desire.account).length === 0 &&
      !forced.includes(desire)
  );
  const moves = (group: readonly Desire[]) => (agrees(shape(group), sharedNow, allKeys) ? 0 : 1);
  let bestGroup: readonly Desire[] = forced;
  let bestScore = -moves(forced);
  // Branch and bound over the followers; a budget keeps a pathological hub responsive.
  let budget = 200_000;
  const visit = (from: number, group: readonly Desire[], count: number) => {
    if (--budget < 0) return;
    const score = count - moves(group);
    if (score > bestScore) {
      bestGroup = group;
      bestScore = score;
    }
    for (let index = from; index < optional.length; index += 1) {
      if (count + optional.length - index <= bestScore) return;
      const next = optional[index];
      if (group.every((member) => fits(member, next)))
        visit(index + 1, [...group, next], count + 1);
    }
  };
  visit(0, forced, 0);
  const outcome = evaluate(inventory, models, desires, shape(bestGroup));
  if (!outcome.ok) return { status: 'blocked', block: outcome.block };
  const best = outcome;
  if (best.writes.length === 0) return { status: 'none' };
  // An account that could not be read may follow the provider list: never move it under it.
  if (unreadable.length > 0 && best.writes.some((write) => write.target.kind === 'provider')) {
    return { status: 'blocked', block: { code: 'unreadable', accounts: unreadable } };
  }

  // Everything the result was computed from but does not write is checked again before writing.
  const written = new Set(
    best.writes.map((write) =>
      write.target.kind === 'provider' ? 'provider' : `account:${write.target.name}`
    )
  );
  const guards: ListGuard[] = [];
  if (!written.has('provider')) {
    guards.push({
      target: { kind: 'provider' },
      expected: asList(normalizeExcludedRules(inventory.providerList)),
    });
  }
  for (const account of inventory.accounts) {
    if (account.kind !== 'file' || !known(account) || written.has(`account:${account.name}`))
      continue;
    guards.push({
      target: { kind: 'account', name: account.name },
      expected: asList(ownRulesOf(account)),
    });
  }
  return { status: 'ready', writes: best.writes, guards, expansions: best.expansions };
}
