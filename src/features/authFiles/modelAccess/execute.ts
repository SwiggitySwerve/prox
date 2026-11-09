/**
 * Applies a write plan's list writes one at a time. The Management API has no atomic multi-list
 * write, so safety comes from the order and from never hiding a partial result:
 *
 * 1. Stale check: re-read every target; if any differs from what the preview was built on,
 *    write nothing and report `stale`.
 * 2. Account lists first, the provider list last. For "disable everywhere" this never widens what
 *    is served mid-plan: an account with its own list is closed before the provider list changes.
 * 3. Every write reports ok or failed; the caller shows them, offers retry (failed writes only,
 *    after a new stale check) or rollback (successful writes reversed, guarded by their `after`).
 */
import { sameRuleSet } from './accessRule';
import type { ListTarget, ListWrite } from './writePlan';

export interface ListIo {
  readProviderList(): Promise<string[] | null>;
  readAccountList(name: string): Promise<string[] | null>;
  writeProviderList(rules: string[] | null): Promise<void>;
  writeAccountList(name: string, rules: string[] | null): Promise<void>;
}

export type WriteOutcome =
  { write: ListWrite; status: 'ok' } | { write: ListWrite; status: 'failed'; message: string };

export interface StaleTarget {
  target: ListTarget;
  expected: string[] | null;
  actual: string[] | null;
}

export type ExecuteResult =
  | { status: 'stale'; stale: StaleTarget[] }
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

export async function executeWrites(
  writes: readonly ListWrite[],
  io: ListIo
): Promise<ExecuteResult> {
  const ordered = orderWrites(writes);
  const stale: StaleTarget[] = [];
  for (const write of ordered) {
    const actual = await readTarget(io, write.target);
    if (!sameRuleSet(actual, write.before)) {
      stale.push({ target: write.target, expected: write.before, actual });
    }
  }
  if (stale.length > 0) return { status: 'stale', stale };

  const outcomes: WriteOutcome[] = [];
  for (const write of ordered) {
    try {
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

export const failedWrites = (outcomes: readonly WriteOutcome[]): ListWrite[] =>
  outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.write);

/** The writes that undo every successful write; each is checked against its original `after`. */
export const rollbackWrites = (outcomes: readonly WriteOutcome[]): ListWrite[] =>
  outcomes
    .filter((outcome) => outcome.status === 'ok')
    .map(({ write }) => ({ target: write.target, before: write.after, after: write.before }));
