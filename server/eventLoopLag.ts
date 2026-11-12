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
  const lag = tickMs - previousTickMs - intervalMs;
  return lag > warnAfterMs ? Math.round(lag) : null;
}

/** Logs a warning when the event loop was blocked for over ~1s; silent when healthy. */
export function startEventLoopLagProbe(
  warn: (message: string) => void = console.warn
): ReturnType<typeof setInterval> {
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const stall = eventLoopStall(previous, now);
    previous = now;
    if (stall !== null) warn(`Event loop blocked for ${stall}ms`);
  }, INTERVAL_MS);
  timer.unref();
  return timer;
}
