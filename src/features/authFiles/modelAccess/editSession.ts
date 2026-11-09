/**
 * Model edit session: one toggle from intent to confirmed result.
 *
 *   idle ──START(plan)───────────────▶ previewing        (no choice needed)
 *   idle ──START(no plan)────────────▶ choosing          (inheriting account: provider or own list?)
 *   choosing ──CHOOSE(plan)──────────▶ previewing
 *   choosing | previewing ──CANCEL──▶ idle
 *   previewing ──APPLY───────────────▶ saving
 *   saving ──SETTLED(saved)──────────▶ saved
 *   saving ──SETTLED(partial)────────▶ partial-failure
 *   saving ──SETTLED(failed)─────────▶ failed
 *   saving ──SETTLED(stale)──────────▶ stale
 *   saving | rolling-back ──ERROR───▶ failed            (a read or the stale check threw)
 *   partial-failure | failed ──RETRY──▶ saving           (failed writes only)
 *   partial-failure ──ROLLBACK───────▶ rolling-back
 *   rolling-back ──SETTLED(saved)────▶ rolled-back
 *   rolling-back ──SETTLED(partial | failed)──▶ partial-failure
 *   rolling-back ──SETTLED(stale)────▶ stale
 *   stale ──REPLAN(plan)─────────────▶ previewing
 *   stale ──CANCEL───────────────────▶ idle
 *   saved | partial-failure | failed | rolled-back ──DISMISS──▶ idle
 *
 * Any other (state, event) pair throws InvalidTransitionError. The UI exposes the state as
 * `data-machine="model-edit-session" data-state="<status>"`.
 */
import type { ExecuteResult, StaleTarget, WriteOutcome } from './execute';
import type { WriteIntent, WritePlan } from './writePlan';

export const EDIT_SESSION_MACHINE = 'model-edit-session';

export type EditSession =
  | { status: 'idle' }
  | { status: 'choosing'; intent: WriteIntent }
  | { status: 'previewing'; plan: WritePlan }
  | { status: 'saving'; plan: WritePlan; operation: 'apply' | 'retry'; outcomes: WriteOutcome[] }
  | { status: 'saved'; plan: WritePlan; outcomes: WriteOutcome[] }
  | { status: 'partial-failure'; plan: WritePlan; outcomes: WriteOutcome[]; rollback: boolean }
  | { status: 'failed'; plan: WritePlan; outcomes: WriteOutcome[]; message: string | null }
  | { status: 'stale'; plan: WritePlan; stale: StaleTarget[] }
  | { status: 'rolling-back'; plan: WritePlan; outcomes: WriteOutcome[] }
  | { status: 'rolled-back'; plan: WritePlan; outcomes: WriteOutcome[] };

export type EditSessionStatus = EditSession['status'];

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
  | { type: 'DISMISS' };

export type EditSessionEventType = EditSessionEvent['type'];

/** Every allowed (state, event) pair and the states it may lead to. */
export const EDIT_SESSION_TRANSITIONS: Record<
  EditSessionStatus,
  Partial<Record<EditSessionEventType, readonly EditSessionStatus[]>>
> = {
  idle: { START: ['choosing', 'previewing'] },
  choosing: { CHOOSE: ['previewing'], CANCEL: ['idle'] },
  previewing: { APPLY: ['saving'], CANCEL: ['idle'] },
  saving: { SETTLED: ['saved', 'partial-failure', 'failed', 'stale'], ERROR: ['failed'] },
  saved: { DISMISS: ['idle'] },
  'partial-failure': { RETRY: ['saving'], ROLLBACK: ['rolling-back'], DISMISS: ['idle'] },
  failed: { RETRY: ['saving'], DISMISS: ['idle'] },
  stale: { REPLAN: ['previewing'], CANCEL: ['idle'] },
  'rolling-back': { SETTLED: ['rolled-back', 'partial-failure', 'stale'], ERROR: ['failed'] },
  'rolled-back': { DISMISS: ['idle'] },
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

/** Merge a retry's outcomes into the earlier ones, keyed by target. */
function mergeOutcomes(previous: WriteOutcome[], next: WriteOutcome[]): WriteOutcome[] {
  const key = (outcome: WriteOutcome) =>
    outcome.write.target.kind === 'provider' ? 'provider' : `account:${outcome.write.target.name}`;
  const replaced = new Map(next.map((outcome) => [key(outcome), outcome]));
  const merged = previous.map((outcome) => replaced.get(key(outcome)) ?? outcome);
  next.forEach((outcome) => {
    if (!previous.some((item) => key(item) === key(outcome))) merged.push(outcome);
  });
  return merged;
}

function next(state: EditSession, event: EditSessionEvent): EditSession {
  switch (event.type) {
    case 'START':
      return event.plan
        ? { status: 'previewing', plan: event.plan }
        : { status: 'choosing', intent: event.intent };
    case 'CHOOSE':
    case 'REPLAN':
      return { status: 'previewing', plan: event.plan };
    case 'CANCEL':
    case 'DISMISS':
      return { status: 'idle' };
    case 'APPLY':
      if (state.status !== 'previewing') break;
      return { status: 'saving', plan: state.plan, operation: 'apply', outcomes: [] };
    case 'RETRY':
      if (state.status !== 'partial-failure' && state.status !== 'failed') break;
      return { status: 'saving', plan: state.plan, operation: 'retry', outcomes: state.outcomes };
    case 'ROLLBACK':
      if (state.status !== 'partial-failure') break;
      return { status: 'rolling-back', plan: state.plan, outcomes: state.outcomes };
    case 'ERROR':
      if (state.status !== 'saving' && state.status !== 'rolling-back') break;
      return {
        status: 'failed',
        plan: state.plan,
        outcomes: state.outcomes,
        message: event.message,
      };
    case 'SETTLED': {
      if (state.status !== 'saving' && state.status !== 'rolling-back') break;
      const { result } = event;
      if (result.status === 'stale')
        return { status: 'stale', plan: state.plan, stale: result.stale };
      if (state.status === 'rolling-back') {
        return result.status === 'saved'
          ? { status: 'rolled-back', plan: state.plan, outcomes: result.outcomes }
          : {
              status: 'partial-failure',
              plan: state.plan,
              outcomes: result.outcomes,
              rollback: true,
            };
      }
      const outcomes =
        state.operation === 'retry'
          ? mergeOutcomes(state.outcomes, result.outcomes)
          : result.outcomes;
      const ok = outcomes.filter((outcome) => outcome.status === 'ok').length;
      if (ok === outcomes.length) return { status: 'saved', plan: state.plan, outcomes };
      if (ok === 0) return { status: 'failed', plan: state.plan, outcomes, message: null };
      return { status: 'partial-failure', plan: state.plan, outcomes, rollback: false };
    }
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unreachable)}`);
    }
  }
  throw new InvalidTransitionError(EDIT_SESSION_MACHINE, state.status, event.type);
}

export function transitionEditSession(state: EditSession, event: EditSessionEvent): EditSession {
  const allowed = EDIT_SESSION_TRANSITIONS[state.status][event.type];
  if (!allowed) throw new InvalidTransitionError(EDIT_SESSION_MACHINE, state.status, event.type);
  const result = next(state, event);
  if (!allowed.includes(result.status)) {
    throw new InvalidTransitionError(EDIT_SESSION_MACHINE, state.status, event.type);
  }
  return result;
}
