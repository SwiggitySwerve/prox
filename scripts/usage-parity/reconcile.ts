// Read-only job provenance. Unavailable or stale status never blocks parity or proves repair.
import type { EventReport } from './events';
import type { QueryGate } from './io';

export interface ReconcileNote {
  status: 'confirmed' | 'not-confirmed' | 'unavailable';
  completed_for_window: true | null;
  observed_at_ms: number;
  message: string;
  job?: {
    id: number;
    kind: 'import' | 'reconcile';
    started_at_ms: number | null;
    finished_at_ms: number | null;
    source_max_id: number | null;
    source_cursor: number | null;
    succeeded: boolean;
    exact: boolean;
    mode_matches: boolean;
  };
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function jobNote(value: unknown, observedAtMs: number): ReconcileNote {
  const note: ReconcileNote = {
    status: 'not-confirmed',
    completed_for_window: null,
    observed_at_ms: observedAtMs,
    message: 'No retained import/reconcile report; prior completion is unknown.',
  };
  const job = object(object(value).job);
  if ((job.kind !== 'import' && job.kind !== 'reconcile') || integer(job.id) === null) return note;
  const result = object(job.result),
    report = object(result.report);
  note.job = {
    id: Number(job.id),
    kind: job.kind,
    started_at_ms: integer(job.startedAtMs),
    finished_at_ms: integer(job.finishedAtMs),
    source_max_id: integer(report.maxId),
    source_cursor: integer(report.lastId),
    succeeded: job.state === 'succeeded',
    exact: result.kind === 'cpamp' && object(report.verification).exact === true,
    mode_matches: report.mode === job.kind,
  };
  note.message =
    'Latest job is not yet evidence of completed exact import/reconcile for this window.';
  return note;
}
export function confirmWindow(note: ReconcileNote, events: EventReport): ReconcileNote {
  const job = note.job;
  if (
    job &&
    events.complete &&
    job.succeeded &&
    job.exact &&
    job.mode_matches &&
    job.started_at_ms !== null &&
    job.started_at_ms >= events.to_ms + 600000 &&
    job.finished_at_ms !== null &&
    job.finished_at_ms >= job.started_at_ms &&
    job.finished_at_ms <= note.observed_at_ms &&
    job.source_max_id !== null &&
    job.source_cursor !== null &&
    job.source_cursor >= job.source_max_id &&
    job.source_max_id >= events.cpamp_max_id
  ) {
    return {
      ...note,
      status: 'confirmed',
      completed_for_window: true,
      message: `Latest completed exact ${job.kind} covers every CPAMP source ID observed in this event window.`,
    };
  }
  return note;
}
export async function observeReconcile(
  url: string,
  key: () => string,
  gate: QueryGate,
  now: () => number
): Promise<ReconcileNote> {
  try {
    return await gate.run(async () => {
      const response = await fetch(new URL('/v1/jobs', url), {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${key()}` },
        signal: AbortSignal.any([gate.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Job status unavailable');
      }
      return jobNote(await response.json(), now());
    });
  } catch {
    gate.signal.throwIfAborted();
    return {
      status: 'unavailable',
      completed_for_window: null,
      observed_at_ms: now(),
      message: 'Latest job status unavailable; event comparison proceeds independently.',
    };
  }
}
