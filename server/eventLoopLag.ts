const INTERVAL_MS = 250;
const WARN_AFTER_MS = 1000;

/**
 * Pure detection step: how long past its schedule a tick ran. Returns the stall in ms
 * when it exceeds the threshold, otherwise null.
 */
export function eventLoopStall(
  previousTickMs: number,
  tickMs: number,
  intervalMs = INTERVAL_MS,
  warnAfterMs = WARN_AFTER_MS
): number | null {
  const lag = eventLoopLagMs(previousTickMs, tickMs, intervalMs);
  return lag > warnAfterMs ? Math.round(lag) : null;
}

/** How long past its schedule a tick ran, in ms; never negative. */
export function eventLoopLagMs(
  previousTickMs: number,
  tickMs: number,
  intervalMs = INTERVAL_MS
): number {
  return Math.max(0, tickMs - previousTickMs - intervalMs);
}

export interface EventLoopLagSnapshot {
  maxLagMs: number;
  stallsOver1s: number;
  lastStallAtMs: number | null;
}

/** Since-start lag figures for a status endpoint. A stall is a tick more than 1 s late. */
export class EventLoopLagStats {
  private maxLagMs = 0;
  private stallsOver1s = 0;
  private lastStallAtMs: number | null = null;

  record(lagMs: number, atMs: number): void {
    this.maxLagMs = Math.max(this.maxLagMs, lagMs);
    if (lagMs > WARN_AFTER_MS) {
      this.stallsOver1s += 1;
      this.lastStallAtMs = atMs;
    }
  }

  snapshot(): EventLoopLagSnapshot {
    return {
      maxLagMs: this.maxLagMs,
      stallsOver1s: this.stallsOver1s,
      lastStallAtMs: this.lastStallAtMs,
    };
  }
}

/** Logs a warning when the event loop was blocked for over ~1s; silent when healthy. */
export function startEventLoopLagProbe(
  warn: (message: string) => void = console.warn,
  stats?: EventLoopLagStats
): ReturnType<typeof setInterval> {
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const stall = eventLoopStall(previous, now);
    stats?.record(eventLoopLagMs(previous, now), Date.now());
    previous = now;
    if (stall !== null) warn(`Event loop blocked for ${stall}ms`);
  }, INTERVAL_MS);
  timer.unref();
  return timer;
}
