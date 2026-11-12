// Worker-owned bulk orchestration. No sockets or HTTP; database work goes through bounded chunks.
import { loadBackupConfig, UsageBackup } from './backup';
import { runCpampJob } from './importCpamp';
import { IoGovernor, runIoChunk, type ChunkScheduler, type IoGovernorOptions } from './ioGovernor';
import { openUsageReader, type RawPruneCursor, type UsageStore } from './store';
import type { BulkJobConfig, BulkJobKind, BulkJobReport } from './writerProtocol';

export class UsageBulkJobs {
  private governor: IoGovernor | null = null;
  private backup: UsageBackup | null = null;
  private latest: BulkJobReport | null = null;
  private active: { controller: AbortController; settled: Promise<void> } | null = null;
  private nextId = 0;
  private closing = false;

  constructor(
    private readonly store: UsageStore,
    private readonly scheduleChunk: ChunkScheduler,
    private readonly config: BulkJobConfig = {},
    private readonly governorOptions: IoGovernorOptions = {}
  ) {}

  report(): BulkJobReport | null {
    if (!this.latest) return null;
    return {
      ...this.latest,
      io: this.governor?.counters ?? this.latest.io,
      lastBackupSuccessAtMs: this.backup?.lastSuccessAtMs ?? null,
    };
  }

  start(kind: BulkJobKind): BulkJobReport {
    if (this.closing || this.active) throw new Error('Bulk job unavailable');
    this.latest = {
      id: ++this.nextId,
      kind,
      state: 'running',
      startedAtMs: Date.now(),
      finishedAtMs: null,
      io: { bytesRead: 0, bytesWritten: 0, pauseSeconds: 0, longPauses: 0 },
      lastBackupSuccessAtMs: this.backup?.lastSuccessAtMs ?? null,
    };
    const controller = new AbortController();
    // Defer orchestration until active is installed, even for a synchronous config failure.
    const settled = Promise.resolve().then(() => this.run(kind, controller.signal));
    this.active = { controller, settled };
    return this.report()!;
  }

  cancel(jobId: number): BulkJobReport {
    if (!this.latest || this.latest.id !== jobId) throw new Error('Bulk job ID differs');
    if (this.active) {
      this.latest.state = 'cancelling';
      this.active.controller.abort();
    }
    return this.report()!;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.active) {
      this.cancel(this.latest!.id);
      await this.active.settled;
    }
  }

  private async run(kind: BulkJobKind, signal: AbortSignal): Promise<void> {
    let source: ReturnType<typeof openUsageReader> | undefined;
    const report = this.latest!;
    try {
      this.governor ??= new IoGovernor({
        bytesPerSecond:
          this.config.bytesPerSecond ??
          (process.env.PROX_USAGE_BULK_BYTES_PER_SECOND
            ? Number(process.env.PROX_USAGE_BULK_BYTES_PER_SECOND)
            : undefined),
        ...this.governorOptions,
      });
      const options = { governor: this.governor, signal, scheduleChunk: this.scheduleChunk };
      if (kind === 'prune') {
        const prune = {
          beforeMs: report.startedAtMs - 30 * 24 * 60 * 60 * 1000,
          deleted: 0,
          chunks: 0,
        };
        report.result = { kind: 'prune', report: prune };
        let cursor: RawPruneCursor = { rejectId: 0 };
        for (;;) {
          const chunk = await runIoChunk(
            'prune',
            () => this.store.pruneRawBefore(prune.beforeMs, cursor),
            options
          );
          prune.deleted += chunk.deleted;
          prune.chunks += 1;
          cursor = chunk.cursor;
          if (chunk.done) break;
        }
      } else if (kind === 'backup') {
        this.backup ??= new UsageBackup(loadBackupConfig(this.config.backupConfigPath), {
          governor: this.governor,
          scheduleChunk: this.scheduleChunk,
        });
        // The backup instance retains last-success state; each run receives its own signal.
        report.result = { kind: 'backup', report: await this.backup.run(this.store, signal) };
      } else {
        const path = this.config.cpampPath ?? process.env.PROX_USAGE_CPAMP_DB_PATH;
        if (!path) throw new Error('CPAMP source not configured');
        await runIoChunk(
          kind,
          () => {
            source = openUsageReader(path);
          },
          options
        );
        report.result = {
          kind: 'cpamp',
          report: await runCpampJob(this.store, source!, {
            ...options,
            mode: kind,
            onProgress: (progress) => {
              report.progress = progress;
            },
          }),
        };
      }
      signal.throwIfAborted();
      report.state = 'succeeded';
    } catch {
      report.state = signal.aborted ? 'cancelled' : 'failed';
      // SQLite paths and S3 credentials/errors must never reach HTTP or logs.
      if (!signal.aborted)
        report.error = 'Usage bulk job failed; check job configuration and source';
    } finally {
      try {
        if (source) await this.scheduleChunk(kind, () => source!.close());
      } catch {
        report.state = 'failed';
        report.error = 'Usage bulk source cleanup failed';
      }
      report.finishedAtMs = Date.now();
      this.active = null;
    }
  }
}
