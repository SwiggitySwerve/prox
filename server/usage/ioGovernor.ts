import { readFileSync } from 'node:fs';

export interface IoClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface IoBytes {
  read: number;
  written: number;
}

export interface IoGovernorOptions {
  bytesPerSecond?: number;
  readPsi?: () => string | Promise<string>;
  clock?: IoClock;
  reportLongPause?: (pauseSeconds: number) => void;
}

/** PSI averages are percentages, not fractions. Missing/broken pressure data fails closed. */
export function fullIoPressure(psi: string): number {
  const match = /^full\s+avg10=(\d+(?:\.\d+)?)\s/m.exec(psi);
  const pressure = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(pressure) || pressure > 100) throw new Error('Invalid IO PSI full avg10');
  return pressure;
}

/** Linux syscall bytes, including cache hits. Keep SQLite mmap disabled for governed scans. */
export function readIoBytes(): IoBytes {
  const io = readFileSync('/proc/thread-self/io', 'utf8');
  const value = (key: string) => {
    const match = new RegExp(`^${key}: (\\d+)$`, 'm').exec(io);
    if (!match) throw new Error(`Missing IO byte counter: ${key}`);
    return Number(match[1]);
  };
  return { read: value('rchar'), written: value('wchar') };
}

/** Share one governor across bulk jobs in the writer queue. Live batches bypass it. */
export class IoGovernor {
  private readonly clock: IoClock;
  private readonly readPsi: () => string | Promise<string>;
  private readonly rate: number;
  private chunkStartedAtMs: number | null = null;
  private pausedAtMs: number | null = null;
  private pauseMs = 0;
  private severe = false;
  private quietSince: number | null = null;
  private pauseReported = false;
  private pacingDeadlineMs = 0;
  private bytes: IoBytes = { read: 0, written: 0 };
  private longPauses = 0;

  constructor(private readonly options: IoGovernorOptions = {}) {
    this.rate = options.bytesPerSecond ?? 4_000_000;
    if (!Number.isFinite(this.rate) || this.rate <= 0) throw new Error('Invalid IO byte budget');
    this.clock = options.clock ?? {
      now: () => performance.now(),
      sleep: (ms) => Bun.sleep(ms),
    };
    this.readPsi = options.readPsi ?? (() => readFileSync('/proc/pressure/io', 'utf8'));
  }

  /** Check pressure and debt at execution without sleeping inside the writer queue. */
  async admitChunk(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (this.clock.now() < this.pacingDeadlineMs) return false;
    const pressure = fullIoPressure(await this.readPsi());
    signal?.throwIfAborted();
    const now = this.clock.now();
    if (pressure >= 15) this.severe = true;
    if (pressure < 5) this.quietSince ??= now;
    else this.quietSince = null;
    if (pressure >= 5 || (this.severe && now - this.quietSince! < 30_000)) return false;
    this.severe = false;
    this.quietSince = null;
    this.pauseReported = false;
    this.chunkStartedAtMs = now;
    return true;
  }

  /** No chunk starts at 5% or above. At 15%, require 30 continuous seconds below 5%. */
  async waitForQuietIo(signal?: AbortSignal): Promise<void> {
    try {
      await this.settleByteDebt(signal);
      for (;;) {
        if (await this.admitChunk(signal)) return;
        const now = this.clock.now();
        this.pausedAtMs ??= now;
        if (!this.pauseReported && now - this.pausedAtMs > 6 * 60 * 60 * 1000) {
          this.pauseReported = true;
          this.longPauses += 1;
          const seconds = (now - this.pausedAtMs) / 1000;
          if (this.options.reportLongPause) this.options.reportLongPause(seconds);
          else console.warn(`Usage bulk job still paused by IO pressure after ${seconds} seconds`);
        }
        await this.clock.sleep(1000);
      }
    } finally {
      // A later call cannot prove pressure stayed quiet while this wait was not monitoring it.
      this.quietSince = null;
      if (this.pausedAtMs !== null) {
        this.pauseMs += this.clock.now() - this.pausedAtMs;
        this.pausedAtMs = null;
      }
    }
  }

  /** Report every chunk, even on failure. Elapsed work counts; idle time earns no burst credit. */
  async reportBytes(bytes: IoBytes, signal?: AbortSignal): Promise<void> {
    if (![bytes.read, bytes.written].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error('IO byte counts must be non-negative safe integers');
    }
    const started = this.chunkStartedAtMs ?? this.clock.now();
    this.bytes.read += bytes.read;
    this.bytes.written += bytes.written;
    this.pacingDeadlineMs =
      Math.max(this.pacingDeadlineMs, started) +
      Math.ceil(((bytes.read + bytes.written) * 1000) / this.rate);
    // The charge is durable on this governor before the first cancellable sleep.
    this.chunkStartedAtMs = null;
    await this.settleByteDebt(signal);
  }

  private async settleByteDebt(signal?: AbortSignal): Promise<void> {
    while (this.clock.now() < this.pacingDeadlineMs) {
      signal?.throwIfAborted();
      await this.clock.sleep(Math.min(1000, this.pacingDeadlineMs - this.clock.now()));
    }
    this.pacingDeadlineMs = 0;
  }

  get counters() {
    return {
      bytesRead: this.bytes.read,
      bytesWritten: this.bytes.written,
      pauseSeconds:
        (this.pauseMs + (this.pausedAtMs === null ? 0 : this.clock.now() - this.pausedAtMs)) / 1000,
      longPauses: this.longPauses,
    };
  }
}

export type ChunkScheduler = <T>(kind: string, work: () => T | Promise<T>) => Promise<T>;

/** Only synchronous IO is measured in the queue. Admission waits and pacing run outside it. */
export async function runIoChunk<T>(
  kind: string,
  work: () => T,
  options: {
    governor: IoGovernor;
    signal?: AbortSignal;
    scheduleChunk?: ChunkScheduler;
    ioBytes?: () => IoBytes;
  }
): Promise<T> {
  const { governor, signal, scheduleChunk } = options;
  const ioBytes = options.ioBytes ?? readIoBytes;
  for (;;) {
    // Promise continuations alone starve worker messages when pacing has no sleep.
    // Yield outside the queue so live/cancel messages run before the next chunk.
    if (scheduleChunk) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await governor.waitForQuietIo(signal);
    let bytes: IoBytes | undefined;
    const execute = () => {
      signal?.throwIfAborted();
      const before = ioBytes();
      try {
        return { admitted: true as const, value: work() };
      } finally {
        const after = ioBytes();
        bytes = {
          read: Math.max(0, after.read - before.read),
          written: Math.max(0, after.written - before.written),
        };
      }
    };
    try {
      const result = scheduleChunk
        ? await scheduleChunk(kind, async () =>
            (await governor.admitChunk(signal)) ? execute() : { admitted: false as const }
          )
        : execute();
      if (result.admitted) return result.value;
    } finally {
      if (bytes) await governor.reportBytes(bytes, signal);
    }
  }
}
