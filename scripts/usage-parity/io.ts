// All DB reads, local pricing replays and HTTP queries pass through one serial IO gate.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { IoGovernor, readIoBytes, type IoClock } from '../../server/usage/ioGovernor';
import type { ExecutionWindow } from './window';

export class QueryGate {
  private active = false;
  private ended = -Infinity;
  private window?: ExecutionWindow;
  private readonly clock: IoClock;
  readonly governor: IoGovernor;
  queries = 0;
  get signal() {
    return this.window?.signal ?? this.externalSignal;
  }
  /** Install the run's UTC guard even when a test supplies the IO clock/governor. */
  setWindow(window: ExecutionWindow) {
    if (this.active) throw new Error('Cannot change an active query window');
    this.window = window;
  }
  constructor(
    private readonly externalSignal: AbortSignal,
    readonly gapMs = 2000,
    clock?: IoClock,
    readPsi = () => readFileSync('/proc/pressure/io', 'utf8')
  ) {
    if (!Number.isFinite(gapMs) || gapMs < 0) throw new Error('Invalid minimum gap');
    const base = clock ?? {
      now: () => performance.now(),
      sleep: async (ms: number) => {
        await sleep(ms, undefined, { signal: this.signal });
      },
    };
    this.clock = {
      now: () => base.now(),
      sleep: async (ms) => {
        this.check();
        await base.sleep(Math.min(ms, this.window?.remainingMs() ?? Infinity));
        this.check();
      },
    };
    this.governor = new IoGovernor({
      clock: this.clock,
      readPsi: () => {
        this.check();
        return readPsi();
      },
    });
  }
  private check() {
    this.window?.check();
    this.signal.throwIfAborted();
  }
  async run<T>(work: () => T | Promise<T>, measureBytes = false): Promise<T> {
    if (this.active) throw new Error('Concurrent parity queries are forbidden');
    this.active = true;
    try {
      this.check();
      const remaining = this.ended + this.gapMs - this.clock.now();
      if (remaining > 0) await this.clock.sleep(remaining);
      await this.governor.waitForQuietIo(this.signal);
      this.check();
      const before = measureBytes ? readIoBytes() : null;
      this.queries++;
      try {
        const value = await work();
        this.check();
        return value;
      } finally {
        if (before) {
          const after = readIoBytes();
          await this.governor.reportBytes(
            { read: after.read - before.read, written: after.written - before.written },
            this.signal
          );
        }
      }
    } finally {
      this.ended = this.clock.now();
      this.active = false;
    }
  }
}
