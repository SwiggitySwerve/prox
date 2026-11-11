import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  executeWrites,
  pendingAccessChanges,
  planAccessWrites,
  pruneOverrides,
  stageAccess,
  type AccessChange,
  type AccessOverrides,
  type AccessPlan,
  type ListIo,
  type ListTarget,
  type ModelAccessInventory,
} from '@/features/authFiles/modelAccess';

export type SaveFailure = { target: ListTarget; message: string };

/**
 * The last Save, shown in the bar until the next switch or Discard.
 *
 *   idle ──save──▶ saving ──▶ saved | failed | stale | error
 *   any ──stage | discard──▶ idle
 *
 * `failed`: some writes did not land (`written` did); what did not land stays staged.
 * `stale`: a list changed on the hub since it was read; nothing more was written.
 * `error`: the lists could not be checked before writing; nothing was written.
 */
export type DraftSave =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'failed'; failures: SaveFailure[]; written: number }
  | { status: 'stale' }
  | { status: 'error'; message: string };

export type UseAccessDraftResult = {
  overrides: AccessOverrides;
  changes: AccessChange[];
  plan: AccessPlan;
  save: DraftSave;
  stage: (changes: readonly AccessChange[]) => void;
  discard: () => void;
  commit: () => Promise<void>;
};

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';

/**
 * Staged on/off switches for one provider on one hub, and their Save. Nothing is written until
 * commit(): it runs the computed writes through executeWrites (every list re-read first), then
 * re-reads what changed. Switches the re-read shows as landed drop out on their own.
 */
export function useAccessDraft(
  inventory: ModelAccessInventory | null,
  io: ListIo,
  reload: (options?: { written?: readonly ListTarget[] }) => Promise<ModelAccessInventory | null>,
  onChanged?: () => void
): UseAccessDraftResult {
  const [overrides, setOverrides] = useState<AccessOverrides>({});
  const [save, setSave] = useState<DraftSave>({ status: 'idle' });
  const saving = useRef(false);

  // A re-read (after Save, or the top bar's refresh) drops switches that now match the hub.
  useEffect(() => {
    if (inventory) setOverrides((current) => pruneOverrides(inventory, current));
  }, [inventory]);

  const changes = useMemo(
    () => (inventory ? pendingAccessChanges(inventory, overrides) : []),
    [inventory, overrides]
  );
  const plan = useMemo<AccessPlan>(
    () => (inventory ? planAccessWrites(inventory, overrides) : { status: 'none' }),
    [inventory, overrides]
  );

  const stage = useCallback(
    (next: readonly AccessChange[]) => {
      if (!inventory || saving.current) return;
      setOverrides((current) => stageAccess(inventory, current, next));
      setSave({ status: 'idle' });
    },
    [inventory]
  );

  const discard = useCallback(() => {
    if (saving.current) return;
    setOverrides({});
    setSave({ status: 'idle' });
  }, []);

  const commit = useCallback(async () => {
    if (plan.status !== 'ready' || saving.current) return;
    saving.current = true;
    setSave({ status: 'saving' });
    const targets = [
      ...plan.writes.map((write) => write.target),
      ...plan.guards.map((guard) => guard.target),
    ];
    let next: DraftSave;
    try {
      const result = await executeWrites(plan.writes, io, plan.guards);
      const written = result.outcomes.filter((outcome) => outcome.status === 'ok').length;
      if (written > 0) onChanged?.();
      if (result.status === 'stale') next = { status: 'stale' };
      else if (result.status === 'saved') next = { status: 'saved' };
      else {
        next = {
          status: 'failed',
          written,
          failures: result.outcomes.flatMap((outcome) =>
            outcome.status === 'failed'
              ? [{ target: outcome.write.target, message: outcome.message }]
              : []
          ),
        };
      }
    } catch (error) {
      next = { status: 'error', message: messageOf(error) };
    }
    try {
      await reload({ written: targets });
    } catch (error) {
      console.warn(messageOf(error));
    }
    saving.current = false;
    setSave(next);
  }, [io, onChanged, plan, reload]);

  return { overrides, changes, plan, save, stage, discard, commit };
}
