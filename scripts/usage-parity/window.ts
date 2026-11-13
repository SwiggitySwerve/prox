// UTC admission and absolute stop boundaries for the offline parity run.
import { setTimeout, clearTimeout } from 'node:timers';
import { DAY } from './matrix';

export class IncompleteRun extends Error {
  constructor(
    readonly kind: 'deadline' | 'forbidden-hours',
    readonly atMs: number
  ) {
    super(
      kind === 'deadline'
        ? 'UTC deadline reached; partial evidence only'
        : 'Forbidden UTC hours; partial evidence only'
    );
  }
}
export function parseDeadline(value: string, nowMs: number): number {
  const time = /^([01]\d|2[0-3]):([0-5]\d)Z$/.exec(value);
  if (time)
    return Math.floor(nowMs / DAY) * DAY + Number(time[1]) * 3600000 + Number(time[2]) * 60000;
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isSafeInteger(Date.parse(value))
  )
    throw new Error('Invalid UTC deadline');
  return Date.parse(value);
}
export class ExecutionWindow {
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly stopAtMs: number;
  private readonly stopKind: 'deadline' | 'forbidden-hours';
  readonly signal: AbortSignal;
  constructor(
    signal: AbortSignal,
    readonly deadlineMs?: number,
    readonly now = () => Date.now()
  ) {
    if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0))
      throw new Error('Invalid UTC deadline');
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    const at = now(),
      midnight = Math.floor(at / DAY) * DAY;
    const forbidden = this.forbidden(at)
      ? at
      : [midnight + 3600000, midnight + 740 * 60000, midnight + DAY + 3600000].find(
          (time) => time > at
        )!;
    this.stopAtMs = Math.min(forbidden, deadlineMs ?? Infinity);
    this.stopKind =
      deadlineMs !== undefined && deadlineMs <= forbidden ? 'deadline' : 'forbidden-hours';
    this.arm();
  }
  private forbidden(now: number): boolean {
    const minute = (now % DAY) / 60000;
    return (minute >= 60 && minute < 240) || (minute >= 740 && minute < 770);
  }
  check(): void {
    const at = this.now();
    if (at >= this.stopAtMs) this.controller.abort(new IncompleteRun(this.stopKind, at));
    else if (this.forbidden(at)) this.controller.abort(new IncompleteRun('forbidden-hours', at));
    this.signal.throwIfAborted();
  }
  remainingMs(): number {
    this.check();
    return this.stopAtMs - this.now();
  }
  private arm(): void {
    try {
      const remaining = this.remainingMs();
      this.timer = setTimeout(() => this.arm(), Math.max(1, Math.min(remaining, 2147483647)));
      this.timer.unref();
    } catch {
      // check() already aborts the shared signal. The runner writes partial evidence.
    }
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
