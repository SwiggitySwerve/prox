/**
 * One quota runner per group, shared by the group's Refresh and the page-wide "Refresh quota".
 * A request that arrives during a run waits for it, then runs with everything that waited in the
 * meantime as one follow-up run; no request is dropped. React-free; tests/authFilesQuotaRunner.test.ts
 * consumes it directly.
 */
export type QuotaRun<I> = (
  inputs: Array<I | undefined>,
  onSettled: (ok: boolean) => void
) => Promise<void>;

type Waiter<I> = {
  run: QuotaRun<I>;
  input: I | undefined;
  onSettled?: (ok: boolean) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Each request brings the run function of its own render; a batch runs the last one's, once, with
 * the inputs of every request in it, and reports each settled target through onSettled, which
 * reaches every caller in the batch. A request resolves after the run that covers it; if that run
 * throws, the callers it covered reject and the runner carries on with whoever is waiting.
 */
export function createCoalescingRunner<I>(): (
  run: QuotaRun<I>,
  input?: I,
  onSettled?: (ok: boolean) => void
) => Promise<void> {
  let running = false;
  let waiting: Array<Waiter<I>> = [];

  const drain = async () => {
    running = true;
    while (waiting.length > 0) {
      const batch = waiting;
      waiting = [];
      try {
        await batch[batch.length - 1].run(
          batch.map((waiter) => waiter.input),
          (ok) => batch.forEach((waiter) => waiter.onSettled?.(ok))
        );
        batch.forEach((waiter) => waiter.resolve());
      } catch (error) {
        batch.forEach((waiter) => waiter.reject(error));
      }
    }
    running = false;
  };

  return (run, input, onSettled) =>
    new Promise<void>((resolve, reject) => {
      waiting.push({ run, input, onSettled, resolve, reject });
      if (!running) void drain();
    });
}
