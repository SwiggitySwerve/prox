// Injectable time for collection deadlines and retry tests.
export interface UsageClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const usageClock: UsageClock = {
  now: Date.now,
  sleep(ms, signal) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  },
};
