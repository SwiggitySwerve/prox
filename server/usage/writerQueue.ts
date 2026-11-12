// Serial jobs in the writer thread. A bulk job is one bounded chunk, never a whole import.
export class WriterQueue {
  private live: (() => Promise<void>)[] = [];
  private jobs: (() => Promise<void>)[] = [];
  private running = false;

  enqueueJob<T>(kind: string, fn: () => T | Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      (kind === 'live' ? this.live : this.jobs).push(async () => {
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      });
    });
    if (!this.running) queueMicrotask(() => void this.run());
    return result;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.live.length || this.jobs.length) {
        await (this.live.shift() ?? this.jobs.shift())!();
      }
    } finally {
      this.running = false;
    }
  }
}
