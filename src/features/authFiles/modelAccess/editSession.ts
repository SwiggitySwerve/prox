/**
 * Model edit session: one toggle from intent to confirmed result.
 *
 *   idle ──START(plan)───────────────▶ previewing        (no choice needed)
 *   idle ──START(no plan)────────────▶ choosing          (inheriting account: provider or own list?)
 *   choosing ──CHOOSE(plan)──────────▶ previewing
 *   choosing | previewing ──CANCEL──▶ idle
 *   previewing ──APPLY───────────────▶ saving
 *   saving ──SETTLED────────────────▶ saved | partial-failure | failed | stale
 *   rolling-back ──SETTLED──────────▶ rolled-back | partial-failure | failed | stale
 *   saving | rolling-back ──ERROR───▶ failed | partial-failure   (a read or the stale check threw)
 *   partial-failure | failed ──RETRY──▶ saving | rolling-back     (the same operation, unfinished
 *                                                                  writes only)
 *   partial-failure ──ROLLBACK───────▶ rolling-back               (only while applying)
 *   stale ──REPLAN(plan)─────────────▶ previewing                 (only while applying)
 *   stale ──CANCEL───────────────────▶ idle
 *   saved | partial-failure | failed | rolled-back ──DISMISS──▶ idle
 *   any settled state ──REFRESH | REFRESHED──▶ itself              (re-reading the table)
 *
 * After APPLY every state carries the operation in flight (`apply` or `rollback`), the plan's
 * write outcomes and, once a rollback ran, the undo outcomes, so a failure, a stale check or a
 * retry never forgets what is already on the hub: a failed rollback retries the rollback, and a
 * completed rollback always ends in rolled-back. `failed` means the operation wrote nothing;
 * `partial-failure` means some of its writes landed.
 *
 * Any other (state, event) pair throws InvalidTransitionError. The UI exposes the state as
 * `data-machine="model-edit-session" data-state="<status>"`.
 */
import {
  rollbackWrites,
  targetKey,
  type ExecuteResult,
  type StaleTarget,
  type WriteOutcome,
} from './execute';
import type { ListTarget, ListWrite, WriteIntent, WritePlan } from './writePlan';

export const EDIT_SESSION_MACHINE = 'model-edit-session';

export type SessionOperation = 'apply' | 'rollback';

/** Re-reading the table after a run: the write result stands whatever this says. */
export type ViewRefresh = 'running' | 'ok' | 'failed';

/** Everything a session has done since APPLY. */
export interface SessionProgress {
  plan: WritePlan;
  operation: SessionOperation;
  /** The plan's writes, merged across retries (one entry per list). */
  outcomes: WriteOutcome[];
  /** The rollback's writes, merged across retries; empty until a rollback ran. */
  undo: WriteOutcome[];
}

type Settled = SessionProgress & { refresh: ViewRefresh };

export type EditSession =
  | { status: 'idle' }
  | { status: 'choosing'; intent: WriteIntent }
  | { status: 'previewing'; plan: WritePlan }
  | ({ status: 'saving' } & SessionProgress)
  | ({ status: 'rolling-back' } & SessionProgress)
  | ({ status: 'saved' } & Settled)
  | ({ status: 'partial-failure'; message: string | null } & Settled)
  | ({ status: 'failed'; message: string | null } & Settled)
  | ({ status: 'stale'; stale: StaleTarget[] } & Settled)
  | ({ status: 'rolled-back' } & Settled);

export type EditSessionStatus = EditSession['status'];
export type SettledEditSession = Extract<EditSession, { refresh: ViewRefresh }>;

export type EditSessionEvent =
  | { type: 'START'; intent: WriteIntent; plan: WritePlan | null }
  | { type: 'CHOOSE'; plan: WritePlan }
  | { type: 'CANCEL' }
  | { type: 'APPLY' }
  | { type: 'SETTLED'; result: ExecuteResult }
  | { type: 'ERROR'; message: string }
  | { type: 'RETRY' }
  | { type: 'ROLLBACK' }
  | { type: 'REPLAN'; plan: WritePlan }
  | { type: 'DISMISS' }
  | { type: 'REFRESH' }
  | { type: 'REFRESHED'; ok: boolean };

export type EditSessionEventType = EditSessionEvent['type'];

const RERUN = { REFRESH: ['self'], REFRESHED: ['self'] } as const;

/** Every allowed (state, event) pair and the states it may lead to ('self': the same state). */
export const EDIT_SESSION_TRANSITIONS: Record<
  EditSessionStatus,
  Partial<Record<EditSessionEventType, readonly (EditSessionStatus | 'self')[]>>
> = {
  idle: { START: ['choosing', 'previewing'] },
  choosing: { CHOOSE: ['previewing'], CANCEL: ['idle'] },
  previewing: { APPLY: ['saving'], CANCEL: ['idle'] },
  saving: {
    SETTLED: ['saved', 'partial-failure', 'failed', 'stale'],
    ERROR: ['failed', 'partial-failure'],
  },
  saved: { DISMISS: ['idle'], ...RERUN },
  'partial-failure': {
    RETRY: ['saving', 'rolling-back'],
    ROLLBACK: ['rolling-back'],
    DISMISS: ['idle'],
    ...RERUN,
  },
  failed: { RETRY: ['saving', 'rolling-back'], DISMISS: ['idle'], ...RERUN },
  stale: { REPLAN: ['previewing'], CANCEL: ['idle'], ...RERUN },
  'rolling-back': {
    SETTLED: ['rolled-back', 'partial-failure', 'failed', 'stale'],
    ERROR: ['failed', 'partial-failure'],
  },
  'rolled-back': { DISMISS: ['idle'], ...RERUN },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string
  ) {
    super(`${machine}: event ${event} is not allowed in state ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export const INITIAL_EDIT_SESSION: EditSession = { status: 'idle' };

const outcomeKey = (outcome: WriteOutcome) => targetKey(outcome.write.target);

/** Merge a run's outcomes into the earlier ones, keyed by target. */
function mergeOutcomes(previous: WriteOutcome[], next: WriteOutcome[]): WriteOutcome[] {
  const replaced = new Map(next.map((outcome) => [outcomeKey(outcome), outcome]));
  const merged = previous.map((outcome) => replaced.get(outcomeKey(outcome)) ?? outcome);
  next.forEach((outcome) => {
    if (!previous.some((item) => outcomeKey(item) === outcomeKey(outcome))) merged.push(outcome);
  });
  return merged;
}

/** The writes of `writes` that have no successful outcome yet. */
const unfinished = (writes: readonly ListWrite[], outcomes: readonly WriteOutcome[]) =>
  writes.filter(
    (write) =>
      !outcomes.some(
        (outcome) =>
          outcome.status === 'ok' && targetKey(outcome.write.target) === targetKey(write.target)
      )
  );

/**
 * What RETRY must run: the plan's writes that have not landed while applying, or the undo of the
 * landed writes that has not landed yet while rolling back. Never the forward writes of a rollback.
 */
export function pendingWrites(session: SessionProgress): ListWrite[] {
  return session.operation === 'apply'
    ? unfinished(session.plan.writes, session.outcomes)
    : unfinished(rollbackWrites(session.outcomes), session.undo);
}

/** Every list a session touched or found changed: what the table must re-read. */
export function sessionTargets(session: SettledEditSession): ListTarget[] {
  const targets = [
    ...session.plan.writes.map((write) => write.target),
    ...(session.status === 'stale' ? session.stale.map((item) => item.target) : []),
  ];
  return targets.filter(
    (target, index) =>
      targets.findIndex((other) => targetKey(other) === targetKey(target)) === index
  );
}

const anyOk = (outcomes: readonly WriteOutcome[]) =>
  outcomes.some((outcome) => outcome.status === 'ok');

function next(state: EditSession, event: EditSessionEvent): EditSession | null {
  switch (event.type) {
    case 'START':
      return event.plan
        ? { status: 'previewing', plan: event.plan }
        : { status: 'choosing', intent: event.intent };
    case 'CHOOSE':
      return { status: 'previewing', plan: event.plan };
    case 'REPLAN':
      if (state.status !== 'stale' || state.operation !== 'apply') return null;
      return { status: 'previewing', plan: event.plan };
    case 'CANCEL':
    case 'DISMISS':
      return { status: 'idle' };
    case 'APPLY':
      if (state.status !== 'previewing') return null;
      return { status: 'saving', plan: state.plan, operation: 'apply', outcomes: [], undo: [] };
    case 'RETRY': {
      if (state.status !== 'partial-failure' && state.status !== 'failed') return null;
      const { plan, operation, outcomes, undo } = state;
      return {
        status: operation === 'apply' ? 'saving' : 'rolling-back',
        plan,
        operation,
        outcomes,
        undo,
      };
    }
    case 'ROLLBACK':
      if (state.status !== 'partial-failure' || state.operation !== 'apply') return null;
      return {
        status: 'rolling-back',
        plan: state.plan,
        operation: 'rollback',
        outcomes: state.outcomes,
        undo: [],
      };
    case 'ERROR': {
      if (state.status !== 'saving' && state.status !== 'rolling-back') return null;
      const { plan, operation, outcomes, undo } = state;
      const landed = anyOk(operation === 'apply' ? outcomes : undo);
      return {
        status: landed ? 'partial-failure' : 'failed',
        plan,
        operation,
        outcomes,
        undo,
        message: event.message,
        refresh: 'running',
      };
    }
    case 'SETTLED': {
      if (state.status !== 'saving' && state.status !== 'rolling-back') return null;
      const { result } = event;
      const progress: SessionProgress = {
        plan: state.plan,
        operation: state.operation,
        outcomes:
          state.operation === 'apply'
            ? mergeOutcomes(state.outcomes, result.outcomes)
            : state.outcomes,
        undo: state.operation === 'rollback' ? mergeOutcomes(state.undo, result.outcomes) : [],
      };
      if (result.status === 'stale') {
        return { status: 'stale', ...progress, stale: result.stale, refresh: 'running' };
      }
      if (pendingWrites(progress).length === 0) {
        return {
          status: progress.operation === 'apply' ? 'saved' : 'rolled-back',
          ...progress,
          refresh: 'running',
        };
      }
      const landed = anyOk(progress.operation === 'apply' ? progress.outcomes : progress.undo);
      return {
        status: landed ? 'partial-failure' : 'failed',
        ...progress,
        message: null,
        refresh: 'running',
      };
    }
    case 'REFRESH':
    case 'REFRESHED':
      if (!('refresh' in state)) return null;
      return {
        ...state,
        refresh: event.type === 'REFRESH' ? 'running' : event.ok ? 'ok' : 'failed',
      };
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unreachable)}`);
    }
  }
}

export function transitionEditSession(state: EditSession, event: EditSessionEvent): EditSession {
  const allowed = EDIT_SESSION_TRANSITIONS[state.status][event.type];
  if (!allowed) throw new InvalidTransitionError(EDIT_SESSION_MACHINE, state.status, event.type);
  const result = next(state, event);
  const status = result?.status === state.status ? 'self' : result?.status;
  if (!result || !status || !allowed.includes(status)) {
    throw new InvalidTransitionError(EDIT_SESSION_MACHINE, state.status, event.type);
  }
  return result;
}
