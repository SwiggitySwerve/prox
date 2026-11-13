// Main-thread batching and worker RPC. No SQLite or worker module imports are allowed here.
import type {
  SourceResume,
  UsageCursor,
  BulkJobConfig,
  ExporterConfig,
  BulkJobKind,
  BulkJobReport,
  CollectorWriter,
  IngestGap,
  UsagePayload,
  WriterReply,
  WriterRequest,
  WriterStatus,
} from './writerProtocol';
import { WRITER_HIGH_WATER } from './writerProtocol';

export function writerWorkerPath(): string {
  const extension = import.meta.path.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./writer.worker.${extension}`, import.meta.url).pathname;
}

export class UsageWriter implements CollectorWriter {
  private readonly worker: Worker;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(status: WriterStatus): void;
      reject(error: Error): void;
      count: number;
      promise: Promise<WriterStatus>;
      fatal: boolean;
    }
  >();
  private buffered: UsagePayload[] = [];
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private terminated = false;
  private workerDead = false;
  private snapshot: WriterStatus = {
    backlog: 0,
    inserted: 0,
    duplicates: 0,
    rejected: 0,
    rawBufferFailures: 0,
    gaps: 0,
  };
  onOverflow: () => void = () => {};
  onFailure: () => void = () => {};

  constructor(path = writerWorkerPath()) {
    this.worker = new Worker(path);
    this.worker.onmessage = ({ data }: MessageEvent<WriterReply>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (!data.ok) {
        pending.reject(new Error(data.body.fatal ? 'Usage writer failed' : data.body.error));
        if (data.body.fatal) this.fail();
        return;
      }
      this.queued -= pending.count;
      this.snapshot = { ...data.body };
      delete this.snapshot.exporter;
      delete this.snapshot.resume;
      pending.resolve(data.body);
    };
    this.worker.onerror = () => this.workerDied();
    this.worker.addEventListener('close', () => this.workerDied());
  }

  get backlog(): number {
    return this.queued + this.buffered.length;
  }
  get status(): WriterStatus {
    return { ...this.snapshot, backlog: this.backlog };
  }

  async init(
    paths: { events: string; raw: string | null },
    sources: string[],
    nowMs = Date.now(),
    jobs?: BulkJobConfig,
    exporter?: ExporterConfig
  ): Promise<void> {
    await this.send({ kind: 'init', body: { ...paths, sources, nowMs, jobs, exporter } });
  }

  enqueue(payload: UsagePayload): void {
    if (this.failure) throw this.failure;
    if (this.closing || this.terminated) throw new Error('Usage writer is closing');
    const wasHigh = this.backlog > WRITER_HIGH_WATER;
    this.buffered.push(payload);
    if (this.buffered.length >= 100) this.dispatch();
    else if (!this.timer) this.timer = setTimeout(() => this.dispatch(), 50);
    if (!wasHigh && this.backlog > WRITER_HIGH_WATER) this.onOverflow();
  }

  async resume(instance: string): Promise<SourceResume> {
    this.dispatch();
    return (await this.send({ kind: 'resume', body: { instance } })).resume!;
  }

  async replay(
    instance: string,
    payloads: UsagePayload[],
    cursor: UsageCursor,
    gap?: IngestGap,
    complete = false
  ): Promise<void> {
    // Replay can exclude accepted live records from loss counts. Require their commit
    // acknowledgements before posting a cursor that relies on them; queue order alone
    // cannot stop a later job from running after an earlier live transaction fails.
    await this.flush();
    this.queued += payloads.length;
    await this.send(
      { kind: 'replay', body: { instance, payloads, cursor, gap, complete } },
      payloads.length
    );
  }

  async recovery(gap: IngestGap, requireAnchor = false): Promise<void> {
    await this.send({ kind: 'recovery', body: { gap, requireAnchor } });
  }

  async gap(body: IngestGap): Promise<void> {
    await this.send({ kind: 'gap', body });
  }
  async heartbeat(instance: string, atMs: number): Promise<void> {
    // Dispatch first: a durable heartbeat must never advance past uncommitted accepted events.
    this.dispatch();
    await this.send({ kind: 'heartbeat', body: { instance, atMs } });
  }

  async exporterSnapshot(): Promise<NonNullable<WriterStatus['exporter']>> {
    return (await this.send({ kind: 'exporter', body: null }, 0, false)).exporter!;
  }

  async startJob(kind: BulkJobKind): Promise<BulkJobReport> {
    return (await this.send({ kind, body: null }, 0, false)).job!;
  }
  async cancelJob(jobId: number): Promise<BulkJobReport> {
    return (await this.send({ kind: 'cancel', body: { jobId } }, 0, false)).job!;
  }
  async jobReport(): Promise<BulkJobReport | null> {
    return (await this.send({ kind: 'job-status', body: null }, 0, false)).job ?? null;
  }

  async flush(): Promise<void> {
    this.dispatch();
    // Flush is a barrier over all outstanding batches, including those already posted.
    await Promise.all(
      [...this.pending.values()]
        .filter((pending) => pending.fatal)
        .map((pending) => pending.promise)
    );
    await this.send({ kind: 'flush', body: null });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      let flushError: unknown;
      try {
        await this.flush();
      } catch (error) {
        flushError = error;
      }
      try {
        // A failed live commit still needs worker-owned cancellation and handle cleanup.
        if (!this.workerDead) await this.send({ kind: 'close', body: null });
      } finally {
        this.terminated = true;
        this.worker.terminate();
      }
      if (flushError) throw flushError;
    })();
    return this.closing;
  }

  private dispatch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffered.length) return;
    const body = this.buffered;
    this.buffered = [];
    this.queued += body.length;
    void this.send({ kind: 'live', body }, body.length).catch(() => this.fail());
  }

  private send(message: Omit<WriterRequest, 'id'>, count = 0, fatal = true): Promise<WriterStatus> {
    if (this.failure && message.kind !== 'close') return Promise.reject(this.failure);
    if (this.workerDead) return Promise.reject(new Error('Usage worker exited'));
    if (this.terminated || (this.closing && !fatal)) {
      return Promise.reject(new Error('Usage writer is closing'));
    }
    const id = ++this.nextId;
    let resolve!: (status: WriterStatus) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<WriterStatus>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.pending.set(id, { resolve, reject, count, promise, fatal });
    try {
      this.worker.postMessage({ id, ...message });
    } catch {
      this.workerDied();
    }
    return promise;
  }

  private workerDied(): void {
    if (this.terminated) return;
    this.workerDead = true;
    // A live-commit failure may have been recorded already. Reject cleanup RPCs too.
    const error = this.failure ?? new Error('Usage worker exited');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.fail();
  }

  private fail(): void {
    if (this.failure || this.terminated) return;
    this.failure = new Error('Usage writer unavailable');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.onFailure();
  }
}
