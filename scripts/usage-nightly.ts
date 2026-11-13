// Serial operator job chain. No database handles; all mutations use the authenticated job API.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertLoopbackEndpoint } from './usage-parity/run';
import { QueryGate } from './usage-parity/io';
import { ExecutionWindow, IncompleteRun, parseDeadline } from './usage-parity/window';

type JobKind = 'prune' | 'reconcile' | 'backup';
interface Job {
  id: number;
  kind: JobKind;
  state: 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
  startedAtMs: number;
  finishedAtMs: number | null;
}
export interface NightlyOptions {
  url: string;
  keyFile: string;
  // Enable only after the paced snapshot implementation and restore gate have landed.
  backupEnabled: boolean;
  pollMs: number;
}
export interface NightlyReport {
  status: 'succeeded' | 'failed' | 'incomplete';
  completed: string[];
  backup: 'skipped' | 'pending' | 'completed';
  cancellation?: 'requested' | 'unconfirmed';
  error?: string;
}
interface Dependencies {
  signal: AbortSignal;
  now?: () => number;
  gate?: QueryGate;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  parity?: (deadlineMs: number, signal: AbortSignal) => Promise<number>;
}
function jobFrom(value: unknown, kind: JobKind, id?: number): Job {
  const job = (value as { job?: Job } | null)?.job;
  if (
    !job ||
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
    !Number.isSafeInteger(job.startedAtMs) ||
    job.startedAtMs < 0 ||
    job.kind !== kind ||
    (id !== undefined && job.id !== id) ||
    !['running', 'cancelling', 'cancelled', 'succeeded', 'failed'].includes(job.state) ||
    (job.finishedAtMs !== null && !Number.isSafeInteger(job.finishedAtMs))
  )
    throw new Error('Invalid or replaced nightly job');
  return job;
}
class JobHttpFailure extends Error {}

async function parityProcess(deadlineMs: number, signal: AbortSignal): Promise<number> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(5.5 * 3600000)]);
  signal.throwIfAborted();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'usage-parity.ts'),
      '--previous-utc-day',
      '--matrix',
      'quick',
      '--level',
      'both',
      '--deadline',
      new Date(deadlineMs).toISOString(),
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  let force: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill('SIGINT');
    force = setTimeout(() => child.kill('SIGKILL'), 40000);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await child.exited;
  } finally {
    signal.removeEventListener('abort', abort);
    if (force) clearTimeout(force);
  }
}
export async function runNightly(
  options: NightlyOptions,
  dependencies: Dependencies
): Promise<NightlyReport> {
  const now = dependencies.now ?? Date.now;
  const deadline = parseDeadline('12:00Z', now());
  const window = new ExecutionWindow(dependencies.signal, deadline, now);
  const gate = dependencies.gate ?? new QueryGate(dependencies.signal);
  gate.setWindow(window);
  const wait =
    dependencies.sleep ??
    (async (ms, signal) => {
      await sleep(ms, undefined, { signal });
    });
  const report: NightlyReport = {
    status: 'failed',
    completed: [],
    backup: options.backupEnabled ? 'pending' : 'skipped',
  };
  let key = '';
  let active: Job | undefined;
  const request = async (
    path: string,
    body?: object,
    mode: 'query' | 'submit' | 'cleanup' = 'query'
  ): Promise<unknown> => {
    const response = await fetch(new URL(path, options.url), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      // Once submitted, read the accepted ID even if the run is interrupted at noon.
      signal:
        mode === 'query'
          ? AbortSignal.any([window.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(mode === 'cleanup' ? 5000 : 15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new JobHttpFailure('Nightly job HTTP failure');
    }
    return response.json();
  };
  try {
    window.check();
    assertLoopbackEndpoint(options.url);
    if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1)
      throw new Error('Invalid poll interval');
    key = readFileSync(options.keyFile, 'utf8').trim();
    if (!key) throw new Error('Empty nightly credential');
    for (const kind of [
      'prune',
      'reconcile',
      ...(options.backupEnabled ? ['backup'] : []),
    ] as JobKind[]) {
      window.check();
      await gate.run(async () => {
        const submittedAt = now();
        try {
          active = jobFrom(await request('/v1/jobs', { kind }, 'submit'), kind);
        } catch (error) {
          // A lost response can leave an accepted job running. Recover only our new,
          // same-kind job; an HTTP rejection (especially 409) never grants ownership.
          if (!(error instanceof JobHttpFailure)) {
            try {
              const candidate = jobFrom(await request('/v1/jobs', undefined, 'cleanup'), kind);
              if (
                candidate.startedAtMs >= submittedAt &&
                candidate.state === 'running' &&
                candidate.finishedAtMs === null
              )
                active = candidate;
            } catch {
              report.cancellation = 'unconfirmed';
            }
          }
          throw error;
        }
      });
      if (!active) throw new Error('Missing admitted nightly job');
      for (;;) {
        window.check();
        if (
          active.state === 'failed' ||
          active.state === 'cancelled' ||
          active.state === 'cancelling'
        )
          throw new Error('Nightly job did not succeed');
        // State can change before asynchronous source cleanup releases the bulk-job slot.
        if (active.state === 'succeeded' && active.finishedAtMs !== null) break;
        await wait(Math.min(options.pollMs, window.remainingMs()), window.signal);
        window.check();
        const id = active.id;
        active = jobFrom(await gate.run(() => request('/v1/jobs')), kind, id);
      }
      report.completed.push(kind);
      if (kind === 'backup') report.backup = 'completed';
      active = undefined;
    }
    window.check();
    const exit = await (dependencies.parity ?? parityProcess)(deadline, window.signal);
    window.check();
    if (exit === 2) {
      report.status = 'incomplete';
      report.error = 'Nightly parity stopped with incomplete evidence';
      return report;
    }
    if (exit !== 0) throw new Error('Nightly parity did not pass');
    report.completed.push('parity');
    report.status = 'succeeded';
  } catch {
    report.status = window.signal.reason instanceof IncompleteRun ? 'incomplete' : 'failed';
    report.error =
      report.status === 'incomplete'
        ? 'UTC cutoff or forbidden window; chain incomplete'
        : 'Nightly chain stopped; a step failed, was interrupted or could not be verified';
    if (active && active.finishedAtMs === null) {
      // Cancellation is control traffic, admitted even at the stop boundary. Never start more work.
      try {
        await request('/v1/jobs/cancel', { jobId: active.id }, 'cleanup');
        report.cancellation = 'requested';
      } catch {
        report.cancellation = 'unconfirmed';
      }
    }
  } finally {
    window.close();
  }
  return report;
}
if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const report = await runNightly(
    {
      url: 'http://127.0.0.1:18320',
      keyFile: join(homedir(), '.config/cli-proxy-rerank/management-key'),
      backupEnabled: process.env.PROX_USAGE_ENABLE_PACED_BACKUP === '1',
      pollMs: 10000,
    },
    { signal: controller.signal }
  );
  console.log(JSON.stringify(report));
  process.exitCode =
    report.status === 'succeeded'
      ? 0
      : report.status === 'incomplete'
        ? 2
        : controller.signal.aborted
          ? 130
          : 1;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
