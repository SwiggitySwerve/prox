// Main-thread batching and worker RPC. No SQLite or worker module imports are allowed here.
import type {
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
    { resolve(): void; reject(error: Error): void; count: number; promise: Promise<void> }
  >();
  private buffered: UsagePayload[] = [];
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failure: Error | null = null;
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
      if (!data.ok || 'error' in data.body) {
        pending.reject(new Error('Usage writer failed'));
        this.fail();
        return;
      }
      this.queued -= pending.count;
      this.snapshot = data.body;
      pending.resolve();
    };
    this.worker.onerror = () => this.fail();
    this.worker.addEventListener('close', () => this.fail());
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
    nowMs = Date.now()
  ): Promise<void> {
    await this.send({ kind: 'init', body: { ...paths, sources, nowMs } });
  }

  enqueue(payload: UsagePayload): void {
    if (this.failure) throw this.failure;
    const wasHigh = this.backlog > WRITER_HIGH_WATER;
    this.buffered.push(payload);
    if (this.buffered.length >= 100) this.dispatch();
    else if (!this.timer) this.timer = setTimeout(() => this.dispatch(), 50);
    if (!wasHigh && this.backlog > WRITER_HIGH_WATER) this.onOverflow();
  }

  gap(body: IngestGap): Promise<void> {
    return this.send({ kind: 'gap', body });
  }
  heartbeat(instance: string, atMs: number): Promise<void> {
    // Dispatch first: a durable heartbeat must never advance past uncommitted accepted events.
    this.dispatch();
    return this.send({ kind: 'heartbeat', body: { instance, atMs } });
  }

  async flush(): Promise<void> {
    this.dispatch();
    // Flush is a barrier over all outstanding batches, including those already posted.
    await Promise.all([...this.pending.values()].map((pending) => pending.promise));
    await this.send({ kind: 'flush', body: null });
  }

  async close(): Promise<void> {
    try {
      await this.flush();
      await this.send({ kind: 'close', body: null });
    } finally {
      this.worker.terminate();
    }
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

  private send(message: Omit<WriterRequest, 'id'>, count = 0): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.pending.set(id, { resolve, reject, count, promise });
    this.worker.postMessage({ id, ...message });
    return promise;
  }

  private fail(): void {
    if (this.failure) return;
    this.failure = new Error('Usage writer unavailable');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.onFailure();
  }
}
