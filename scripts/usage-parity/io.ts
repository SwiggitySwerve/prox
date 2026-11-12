// All DB reads, local pricing replays and HTTP queries pass through one serial IO gate.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { IoGovernor, readIoBytes } from '../../server/usage/ioGovernor';

export class QueryGate {
  private active = false;
  private ended = -Infinity;
  readonly governor: IoGovernor;
  queries = 0;
  constructor(
    readonly signal: AbortSignal,
    readonly gapMs = 2000,
    private readonly clock = {
      now: () => performance.now(),
      sleep: async (ms: number) => {
        await sleep(ms, undefined, { signal });
      },
    },
    readPsi = () => readFileSync('/proc/pressure/io', 'utf8')
  ) {
    if (!Number.isFinite(gapMs) || gapMs < 0) throw new Error('Invalid minimum gap');
    this.governor = new IoGovernor({ clock, readPsi });
  }
  async run<T>(work: () => T | Promise<T>, measureBytes = false): Promise<T> {
    if (this.active) throw new Error('Concurrent parity queries are forbidden');
    this.active = true;
    try {
      this.signal.throwIfAborted();
      const remaining = this.ended + this.gapMs - this.clock.now();
      if (remaining > 0) await this.clock.sleep(remaining);
      await this.governor.waitForQuietIo(this.signal);
      this.signal.throwIfAborted();
      const before = measureBytes ? readIoBytes() : null;
      this.queries++;
      try {
        return await work();
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
