// Automatic hour scheduling; the shared bulk owner governs and queues each synchronous chunk.
import { createRateBookLoader, DEFAULT_RATE_BOOK_PATH } from './rates';
import type { UsageBulkJobs } from './bulkJobs';
import type { UsageStore } from './store';

export function startHourlyRollups(store: UsageStore, jobs: UsageBulkJobs, path?: string) {
  const loader = createRateBookLoader(path ?? DEFAULT_RATE_BOOK_PATH);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  const schedule = () => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = null;
      active = run().finally(() => {
        active = null;
        schedule();
      });
    }, 1000);
  };
  const run = async () => {
    try {
      await jobs.runRollupChunk(() => {
        const book = loader.load().book ?? { version: 1 as const, models: {} };
        return store.rebuildNextHour(book);
      }, controller.signal);
    } catch {
      // Replacement is transactional. Failed hours stay raw and retry after an event-loop yield.
      if (!controller.signal.aborted)
        console.error('Usage hourly rollup rebuild failed; raw events retained');
    }
  };
  schedule();
  return {
    async close() {
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      await active;
    },
  };
}
