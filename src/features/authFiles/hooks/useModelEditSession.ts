import { useCallback, useRef, useState } from 'react';
import {
  buildWritePlan,
  executeWrites,
  failedWrites,
  INITIAL_EDIT_SESSION,
  InvalidTransitionError,
  needsInheritChoice,
  rollbackWrites,
  transitionEditSession,
  type EditSession,
  type EditSessionEvent,
  type InheritMode,
  type ListIo,
  type ListWrite,
  type ModelAccessInventory,
  type WriteIntent,
} from '@/features/authFiles/modelAccess';

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';

export type UseModelEditSessionResult = {
  session: EditSession;
  start: (intent: WriteIntent) => void;
  choose: (mode: InheritMode) => void;
  apply: () => Promise<void>;
  retry: () => Promise<void>;
  rollback: () => Promise<void>;
  replan: () => Promise<void>;
  close: () => void;
};

/**
 * Runs the model edit session machine (modelAccess/editSession.ts). Every write goes through
 * executeWrites (stale check first); after any write the inventory is re-read so the matrix shows
 * the hub's resulting state, not the state the UI hoped for.
 */
export function useModelEditSession(
  inventory: ModelAccessInventory | null,
  io: ListIo,
  reload: () => Promise<ModelAccessInventory | null>,
  onChanged?: () => void
): UseModelEditSessionResult {
  const [session, setSession] = useState<EditSession>(INITIAL_EDIT_SESSION);
  const sessionRef = useRef(session);

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

  const run = useCallback(
    async (writes: ListWrite[]) => {
      try {
        const result = await executeWrites(writes, io);
        send({ type: 'SETTLED', result });
        if (
          result.status !== 'stale' &&
          result.outcomes.some((outcome) => outcome.status === 'ok')
        ) {
          onChanged?.();
        }
      } catch (error) {
        send({ type: 'ERROR', message: messageOf(error) });
      }
      await reload();
    },
    [io, onChanged, reload, send]
  );

  const start = useCallback(
    (intent: WriteIntent) => {
      if (!inventory) return;
      const plan = needsInheritChoice(inventory, intent) ? null : buildWritePlan(inventory, intent);
      send({ type: 'START', intent, plan });
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
    if (send({ type: 'APPLY' })) await run(current.plan.writes);
  }, [run, send]);

  const retry = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status !== 'partial-failure' && current.status !== 'failed') return;
    const writes =
      current.outcomes.length > 0 ? failedWrites(current.outcomes) : current.plan.writes;
    if (send({ type: 'RETRY' })) await run(writes);
  }, [run, send]);

  const rollback = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status !== 'partial-failure') return;
    if (send({ type: 'ROLLBACK' })) await run(rollbackWrites(current.outcomes));
  }, [run, send]);

  /** After a stale abort: re-read the hub and rebuild the same intent on what is there now. */
  const replan = useCallback(async () => {
    const current = sessionRef.current;
    if (current.status !== 'stale') return;
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
