/**
 * Applies a write plan's list writes one at a time. The Management API has no atomic multi-list
 * write, so safety comes from the order and from never hiding a partial result:
 *
 * 1. Stale check: re-read every target, and every guard (a list the plan depends on but does not
 *    write); if any differs from what the preview was built on, write nothing and report `stale`.
 * 2. Account lists first, the provider list last. For "disable everywhere" this never widens what
 *    is served mid-plan: an account with its own list is closed before the provider list changes.
 * 3. Each target is re-read again right before it is written. If it changed since the check, the
 *    run stops there: `stale`, with what was written before it and what was not.
 * 4. Every write reports ok, failed or skipped; the caller shows them, offers retry (unfinished
 *    writes only, after a new stale check) or rollback (successful writes reversed, guarded by
 *    their `after`).
 *
 * Without an atomic compare-and-set endpoint a small window remains between each re-read and its
 * write (and between the guard check and the last write), in which another operator's change can
 * still be overwritten. The re-reads shrink it to one request; they cannot close it.
 */
import { followsProviderList, sameRuleSet } from './accessRule';
import type { AccountAccess } from './resolve';
import type { ListGuard, ListTarget, ListWrite } from './writePlan';

export interface ListIo {
  readProviderList(): Promise<string[] | null>;
  readAccountList(name: string): Promise<string[] | null>;
  writeProviderList(rules: string[] | null): Promise<void>;
  writeAccountList(name: string, rules: string[] | null): Promise<void>;
}

export type WriteOutcome =
  | { write: ListWrite; status: 'ok' }
  | { write: ListWrite; status: 'failed'; message: string }
  /** Not attempted: the run stopped at an earlier list that had changed. */
  | { write: ListWrite; status: 'skipped' };

export interface StaleTarget {
  target: ListTarget;
  expected: string[] | null;
  actual: string[] | null;
  /** A list the plan depends on but does not write. */
  guard?: boolean;
}

export type ExecuteResult =
  /** `outcomes`: one per write; ok ones were written before the run stopped. */
  | { status: 'stale'; stale: StaleTarget[]; outcomes: WriteOutcome[] }
  | { status: 'saved' | 'partial-failure' | 'failed'; outcomes: WriteOutcome[] };

export const targetKey = (target: ListTarget): string =>
  target.kind === 'provider' ? 'provider' : `account:${target.name}`;

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : String(error);

/** Account writes before the provider write; otherwise the plan's order. */
export const orderWrites = (writes: readonly ListWrite[]): ListWrite[] => [
  ...writes.filter((write) => write.target.kind === 'account'),
  ...writes.filter((write) => write.target.kind === 'provider'),
];

async function readTarget(io: ListIo, target: ListTarget) {
  return target.kind === 'provider' ? io.readProviderList() : io.readAccountList(target.name);
}

/**
 * A read that throws during the first check propagates (nothing has been written; the session
 * turns it into `failed`). After the first write nothing throws: every outcome is reported.
 */
export async function executeWrites(
  writes: readonly ListWrite[],
  io: ListIo,
  guards: readonly ListGuard[] = []
): Promise<ExecuteResult> {
  const ordered = orderWrites(writes);
  const skipped = (from: number): WriteOutcome[] =>
    ordered.slice(from).map((write) => ({ write, status: 'skipped' }));
  const stale: StaleTarget[] = [];
  for (const write of ordered) {
    const actual = await readTarget(io, write.target);
    if (!sameRuleSet(actual, write.before)) {
      stale.push({ target: write.target, expected: write.before, actual });
    }
  }
  const written = new Set(ordered.map((write) => targetKey(write.target)));
  for (const guard of guards) {
    if (written.has(targetKey(guard.target))) continue;
    const actual = await readTarget(io, guard.target);
    if (!sameRuleSet(actual, guard.expected)) {
      stale.push({ target: guard.target, expected: guard.expected, actual, guard: true });
    }
  }
  if (stale.length > 0) return { status: 'stale', stale, outcomes: skipped(0) };

  const outcomes: WriteOutcome[] = [];
  for (const [index, write] of ordered.entries()) {
    try {
      const actual = await readTarget(io, write.target);
      if (!sameRuleSet(actual, write.before)) {
        return {
          status: 'stale',
          stale: [{ target: write.target, expected: write.before, actual }],
          outcomes: [...outcomes, ...skipped(index)],
        };
      }
      if (write.target.kind === 'provider') await io.writeProviderList(write.after);
      else await io.writeAccountList(write.target.name, write.after);
      outcomes.push({ write, status: 'ok' });
    } catch (error) {
      outcomes.push({ write, status: 'failed', message: message(error) });
    }
  }
  const ok = outcomes.filter((outcome) => outcome.status === 'ok').length;
  return {
    status: ok === outcomes.length ? 'saved' : ok === 0 ? 'failed' : 'partial-failure',
    outcomes,
  };
}

/** The writes that did not land (failed or never attempted). */
export const failedWrites = (outcomes: readonly WriteOutcome[]): ListWrite[] =>
  outcomes.filter((outcome) => outcome.status !== 'ok').map((outcome) => outcome.write);

/** The writes that undo every successful write; each is checked against its original `after`. */
export const rollbackWrites = (outcomes: readonly WriteOutcome[]): ListWrite[] =>
  outcomes
    .filter((outcome) => outcome.status === 'ok')
    .map(({ write }) => ({ target: write.target, before: write.after, after: write.before }));

/**
 * What to re-read after writing these lists (the provider lists are always re-read): the written
 * accounts' own lists, and the reported models of every account whose rules in effect may have
 * changed: the written accounts, plus every enabled inheriting account when the provider list
 * was written. An account whose list is unknown counts as inheriting, and so does a runtime
 * credential (it has no list of its own). Disabled accounts serve nothing.
 */
export function refreshScope(
  targets: readonly ListTarget[],
  accounts: readonly Pick<AccountAccess, 'name' | 'kind' | 'disabled' | 'ownList'>[]
): { lists: string[]; models: string[] } {
  const names = new Set(
    targets.flatMap((target) => (target.kind === 'account' ? [target.name] : []))
  );
  const files = accounts.filter((account) => account.kind === 'file');
  const lists = files.filter((account) => names.has(account.name)).map((account) => account.name);
  const inheriting = targets.some((target) => target.kind === 'provider')
    ? accounts.filter(
        (account) =>
          !names.has(account.name) &&
          (account.ownList.status !== 'known' || followsProviderList(account.ownList.rules))
      )
    : [];
  const models = [...files.filter((account) => names.has(account.name)), ...inheriting]
    .filter((account) => !account.disabled)
    .map((account) => account.name);
  return { lists, models };
}
