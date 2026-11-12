// Independent FIFO admission queues. A deadline includes queueing and active execution.
import { AnalyticsError } from './validate';
import type { UsageAnalyticsQuery } from './validate';

export type QueryExecutor<T> = (
  query: UsageAnalyticsQuery,
  deadline: number,
  signal: AbortSignal
) => Promise<T>;
interface Job<T> {
  query: UsageAnalyticsQuery;
  deadline: number;
  controller: AbortController;
  resolve(value: T): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  removeAbort(): void;
}
class Lane<T> {
  private waiting: Job<T>[] = [];
  private active: Job<T> | null = null;
  private closed = false;
  constructor(private execute: QueryExecutor<T>) {}
  submit(query: UsageAnalyticsQuery, deadline: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new AnalyticsError('Analytics is shutting down', 503));
    if (signal?.aborted) return Promise.reject(new AnalyticsError('Request cancelled', 499));
    if (deadline <= Date.now())
      return Promise.reject(new AnalyticsError('Analytics deadline exceeded', 504));
    if (this.active && this.waiting.length >= 8)
      return Promise.reject(new AnalyticsError('Analytics lane is full', 503));
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        query,
        deadline,
        controller: new AbortController(),
        resolve,
        reject,
        timer: setTimeout(
          () => cancel(new AnalyticsError('Analytics deadline exceeded', 504)),
          deadline - Date.now()
        ),
        settled: false,
        removeAbort: () => signal?.removeEventListener('abort', abort),
      };
      const cancel = (error: AnalyticsError) => {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(job.timer);
        job.removeAbort();
        this.waiting = this.waiting.filter((pending) => pending !== job);
        job.controller.abort(error);
        reject(error);
        // Keep the active slot until the executor confirms termination, never run two readers.
      };
      const abort = () => cancel(new AnalyticsError('Request cancelled', 499));
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(job);
      this.pump();
    });
  }
  close() {
    this.closed = true;
    for (const job of [...this.waiting, ...(this.active ? [this.active] : [])]) {
      if (job.settled) continue;
      job.settled = true;
      clearTimeout(job.timer);
      job.removeAbort();
      job.controller.abort();
      job.reject(new AnalyticsError('Analytics is shutting down', 503));
    }
    this.waiting = [];
  }
  private pump() {
    if (this.active || this.closed) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.active = job;
    void Promise.resolve()
      .then(() => this.execute(job.query, job.deadline, job.controller.signal))
      .then(
        (result) => {
          if (!job.settled) job.resolve(result);
        },
        (error) => {
          if (!job.settled) job.reject(error);
        }
      )
      .finally(() => {
        job.settled = true;
        clearTimeout(job.timer);
        job.removeAbort();
        this.active = null;
        this.pump();
      });
  }
}
export function createAnalyticsLanes<T>(executors: {
  fast: QueryExecutor<T>;
  search: QueryExecutor<T>;
}) {
  const fast = new Lane(executors.fast);
  const search = new Lane(executors.search);
  return {
    query(query: UsageAnalyticsQuery, options: { deadline?: number; signal?: AbortSignal } = {}) {
      return (query.search?.trim() ? search : fast).submit(
        query,
        options.deadline ?? Date.now() + 30000,
        options.signal
      );
    },
    close() {
      fast.close();
      search.close();
    },
  };
}
