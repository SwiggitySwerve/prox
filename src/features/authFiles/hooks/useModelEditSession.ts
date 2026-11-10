import { useCallback, useRef, useState } from 'react';
import {
  buildWritePlan,
  executeWrites,
  INITIAL_EDIT_SESSION,
  InvalidTransitionError,
  needsInheritChoice,
  pendingWrites,
  sessionTargets,
  transitionEditSession,
  type EditSession,
  type EditSessionEvent,
  type InheritMode,
  type ListGuard,
  type ListIo,
  type ListTarget,
  type ListWrite,
  type ModelAccessInventory,
  type SettledEditSession,
  type WriteIntent,
} from '@/features/authFiles/modelAccess';

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';

const isSettled = (session: EditSession): session is SettledEditSession => 'refresh' in session;

export type UseModelEditSessionResult = {
  session: EditSession;
  start: (intent: WriteIntent) => void;
  choose: (mode: InheritMode) => void;
  apply: () => Promise<void>;
  /** Retry the unfinished writes; when no write is left to retry, retry re-reading the table. */
  retry: () => Promise<void>;
  rollback: () => Promise<void>;
  replan: () => Promise<void>;
  close: () => void;
};

/**
 * Runs the model edit session machine (modelAccess/editSession.ts). Every write goes through
 * executeWrites (stale check first); after any run the lists it touched are re-read so the matrix
 * shows the hub's resulting state, not the state the UI hoped for. A failed re-read never turns a
 * landed write into a failure: the session records it (`refresh: 'failed'`) and retry re-reads.
 */
export function useModelEditSession(
  inventory: ModelAccessInventory | null,
  io: ListIo,
  reload: (options?: { written?: readonly ListTarget[] }) => Promise<ModelAccessInventory | null>,
  onChanged?: () => void
): UseModelEditSessionResult {
  const [session, setSession] = useState<EditSession>(INITIAL_EDIT_SESSION);
  const sessionRef = useRef(session);
  /** Bumped by every new session and every re-read, so a late re-read result is dropped. */
  const refreshSeq = useRef(0);

  /** Apply an event; an event invalid for the current state is dropped and logged. */
  const send = useCallback((event: EditSessionEvent): boolean => {
    try {
      const next = transitionEditSession(sessionRef.current, event);
      sessionRef.current = next;
      setSession(next);
      return true;
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        console.warn(error.message);
        return false;
      }
      throw error;
    }
  }, []);

  /** Re-read the lists the session touched; the outcome only marks whether the table is current. */
  const refreshView = useCallback(async () => {
    const current = sessionRef.current;
    if (!isSettled(current)) return;
    const seq = ++refreshSeq.current;
    if (current.refresh !== 'running') send({ type: 'REFRESH' });
    let ok = false;
    try {
      ok = (await reload({ written: sessionTargets(current) })) !== null;
    } catch (error) {
      console.warn(messageOf(error));
    }
    if (seq === refreshSeq.current && isSettled(sessionRef.current)) {
      send({ type: 'REFRESHED', ok });
    }
  }, [reload, send]);

  const run = useCallback(
    async (writes: ListWrite[], guards: readonly ListGuard[]) => {
      try {
        const result = await executeWrites(writes, io, guards);
        send({ type: 'SETTLED', result });
        if (result.outcomes.some((outcome) => outcome.status === 'ok')) onChanged?.();
      } catch (error) {
        send({ type: 'ERROR', message: messageOf(error) });
      }
      await refreshView();
    },
    [io, onChanged, refreshView, send]
  );

  const start = useCallback(
    (intent: WriteIntent) => {
      if (!inventory) return;
      const plan = needsInheritChoice(inventory, intent) ? null : buildWritePlan(inventory, intent);
      if (send({ type: 'START', intent, plan })) refreshSeq.current += 1;
    },
    [inventory, send]
  );

  const choose = useCallback(
    (mode: InheritMode) => {
      const current = sessionRef.current;
      if (!inventory || current.status !== 'choosing' || current.intent.type !== 'account-model')
        return;
      send({ type: 'CHOOSE', plan: buildWritePlan(inventory, { ...current.intent, mode }) });
    },
    [inventory, send]
  );

  const apply = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status !== 'previewing' || !current.plan.canApply) return;
    if (send({ type: 'APPLY' })) await run(current.plan.writes, current.plan.guards);
  }, [run, send]);

  /**
   * Retry the operation that did not finish: the plan's unfinished writes while applying (with
   * the plan's guards), the unfinished undo while rolling back (a rollback restores the lists as
   * they were, so it depends on no other list). Never the forward writes of a rollback.
   */
  const retry = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status === 'partial-failure' || current.status === 'failed') {
      const writes = pendingWrites(current);
      const guards = current.operation === 'apply' ? current.plan.guards : [];
      if (send({ type: 'RETRY' })) await run(writes, guards);
      return;
    }
    if (isSettled(current) && current.refresh === 'failed') await refreshView();
  }, [refreshView, run, send]);

  const rollback = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status !== 'partial-failure' || current.operation !== 'apply') return;
    if (send({ type: 'ROLLBACK' })) {
      const next = sessionRef.current;
      if (next.status === 'rolling-back') await run(pendingWrites(next), []);
    }
  }, [run, send]);

  /**
   * After a stale abort while applying: re-read the hub and rebuild the same intent on what is
   * there now (it already includes any write that landed). A stale rollback is never replanned:
   * its intent is the forward change the user was undoing.
   */
  const replan = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status !== 'stale' || current.operation !== 'apply') return;
    const fresh = await reload();
    if (!fresh || sessionRef.current.status !== 'stale') return;
    const intent = current.plan.intent;
    try {
      send({ type: 'REPLAN', plan: buildWritePlan(fresh, intent) });
    } catch (error) {
      send({ type: 'CANCEL' });
      console.warn(messageOf(error));
    }
  }, [reload, send]);

  const close = useCallback(() => {
    const status = sessionRef.current.status;
    if (status === 'choosing' || status === 'previewing' || status === 'stale')
      send({ type: 'CANCEL' });
    else if (
      status === 'saved' ||
      status === 'partial-failure' ||
      status === 'failed' ||
      status === 'rolled-back'
    )
      send({ type: 'DISMISS' });
  }, [send]);

  return { session, start, choose, apply, retry, rollback, replan, close };
}
