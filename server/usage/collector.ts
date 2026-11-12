// Per-source socket lifecycle, destructive queue drain and credential refresh scheduling.
import { readFile } from 'node:fs/promises';
import type { DeploymentSource } from '../../src/domain/providerSources/types';
import { CredentialLabels } from './labels';
import { subscribeUsage, type UsageSubscription } from './resp';
import { readProxyJson, UsageAuthError } from './proxyHttp';
import { usageClock, type UsageClock } from './clock';
import { INGEST, type IngestSource } from './types';
import { WRITER_HIGH_WATER, type CollectorWriter, type IngestGap } from './writerProtocol';

export interface SourceStatus {
  instance: string;
  state: 'connecting' | 'subscribed' | 'backoff' | 'auth-error' | 'paused' | 'stopped';
  lastEventAtMs: number | null;
  lastActivityAtMs: number | null;
  drainRequests: number;
  drained: number;
  reconnects: number;
  retryAtMs: number | null;
  labelRefreshFailures: number;
}
export interface CollectorOptions {
  clock?: UsageClock;
  fetcher?: typeof fetch;
  readKey?: (path: string) => Promise<string>;
}

export class UsageCollector {
  readonly status: SourceStatus;
  private readonly clock: UsageClock;
  private readonly labels: CredentialLabels;
  private readonly stopping = new AbortController();
  private connection: UsageSubscription | null = null;
  private socketLifetime: AbortController | null = null;
  private session: AbortController | null = null;
  private running: Promise<void> | null = null;
  private key = '';
  private authRetryAt = 0;
  private dropReason: IngestGap['reason'] = 'subscription-dropped';
  private labelsPending: Promise<void> | null = null;
  private outageAt: number | null = null;

  constructor(
    private readonly source: DeploymentSource,
    private readonly writer: CollectorWriter,
    private readonly options: CollectorOptions = {}
  ) {
    this.clock = options.clock ?? usageClock;
    this.status = {
      instance: source.instanceId,
      state: 'stopped',
      lastEventAtMs: null,
      lastActivityAtMs: null,
      drainRequests: 0,
      drained: 0,
      reconnects: 0,
      retryAtMs: null,
      labelRefreshFailures: 0,
    };
    this.labels = new CredentialLabels(() => this.read('credentials'), this.clock.now);
  }

  start(): void {
    if (!this.running) this.running = this.run();
  }

  /** Called for every source when the shared writer crosses its high-water mark. */
  overflow(): void {
    this.dropReason = 'writer-overflow';
    this.session?.abort();
    this.connection?.close();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    // Cancel HTTP and timers, but keep the socket alive through the unsubscribe acknowledgement.
    if (!this.connection) this.socketLifetime?.abort();
    let failure: unknown;
    try {
      await this.connection?.unsubscribe();
    } catch (error) {
      failure = error;
    }
    this.session?.abort();
    await this.running;
    if (failure) throw failure;
  }

  private async read(path: string): Promise<unknown> {
    if (this.clock.now() < this.authRetryAt) throw new UsageAuthError();
    try {
      return await readProxyJson(
        this.source.upstreamOrigin,
        path,
        this.key,
        this.session?.signal ?? this.stopping.signal,
        this.options.fetcher
      );
    } catch (error) {
      if (error instanceof UsageAuthError) {
        this.authRetryAt = this.clock.now() + 60_000;
        this.session?.abort();
        this.connection?.close();
      }
      throw error;
    }
  }

  private refreshLabels(force = false, unknown?: string): void {
    if (this.labelsPending || this.stopping.signal.aborted) return;
    this.labelsPending = (unknown ? this.labels.unknown(unknown) : this.labels.refresh(force))
      .catch(() => {
        this.status.labelRefreshFailures += 1;
      })
      .finally(() => {
        this.labelsPending = null;
      });
  }

  private accept(payload: unknown, ingest: IngestSource): void {
    // Parse only enough routing metadata for labels/controls. Normalization stays in the writer.
    let record: unknown = payload;
    if (typeof record === 'string') {
      try {
        record = JSON.parse(record);
      } catch {
        /* Writer counts malformed JSON safely. */
      }
    }
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      const meta = record as Record<string, unknown>;
      if (meta.support_refresh === true) return;
      if (meta.refresh === true) {
        this.refreshLabels(true);
        return;
      }
      const index = typeof meta.auth_index === 'string' ? meta.auth_index.trim() : '';
      const label = this.labels.labelFor(index);
      if (index && !label) this.refreshLabels(false, index);
      this.writer.enqueue({
        instance: this.source.instanceId,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ingest,
        label,
      });
    } else {
      this.writer.enqueue({
        instance: this.source.instanceId,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ingest,
      });
    }
    this.status.lastEventAtMs = this.clock.now();
    if (this.writer.backlog > WRITER_HIGH_WATER) this.overflow();
  }

  private gap(fromMs: number, reason: IngestGap['reason']): Promise<void> {
    return this.writer.gap({
      instance: this.source.instanceId,
      fromMs,
      toMs: this.clock.now(),
      reason,
    });
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    let attempts = 0;
    try {
      while (!this.stopping.signal.aborted) {
        if (this.writer.backlog > 1000 && this.dropReason === 'writer-overflow') {
          this.status.state = 'paused';
          await this.clock.sleep(1000, this.stopping.signal);
          continue;
        }
        this.status.state = 'connecting';
        this.status.retryAtMs = null;
        if (attempts++ > 0) this.status.reconnects += 1;
        this.session = new AbortController();
        let connectedAt: number | null = null;
        let timer: Promise<void> | null = null;
        const socketLifetime = new AbortController();
        this.socketLifetime = socketLifetime;
        try {
          this.key = (
            await (this.options.readKey ?? (async (path) => readFile(path, 'utf8')))(
              this.source.managementKeyFile
            )
          ).trim();
          if (!this.key) throw new UsageAuthError();
          if (this.stopping.signal.aborted) break;
          this.connection = await subscribeUsage({
            origin: this.source.upstreamOrigin,
            key: this.key,
            signal: socketLifetime.signal,
            onActivity: () => {
              this.status.lastActivityAtMs = this.clock.now();
            },
            onPayload: (payload) => this.accept(payload, INGEST.subscribed),
          });
          const session = this.session;
          void this.connection.closed.then(() => session.abort());
          connectedAt = this.clock.now();
          timer = this.monitor(this.connection, this.session.signal).catch(() => {
            this.connection?.close();
          });
          if (this.outageAt !== null) {
            await this.gap(this.outageAt, this.dropReason);
            this.outageAt = null;
          }
          this.dropReason = 'subscription-dropped';
          this.status.state = 'subscribed';
          // Drain and labels share one HTTP auth circuit: one failure blocks all subsequent reads.
          await this.labels.refresh(true);
          while (!this.session.signal.aborted && !this.stopping.signal.aborted) {
            const records = await this.read('observability/usage/queue?count=100');
            this.status.drainRequests += 1;
            if (!Array.isArray(records)) throw new Error('Invalid usage queue response');
            if (!records.length) break;
            for (const payload of records) this.accept(payload, INGEST.drained);
            this.status.drained += records.length;
          }
          await this.connection.closed;
        } catch (error) {
          if (error instanceof UsageAuthError) this.authRetryAt = this.clock.now() + 60_000;
        } finally {
          this.session.abort();
          this.connection?.close();
          socketLifetime.abort();
          await timer;
          await this.labelsPending;
          this.connection = null;
        }
        if (connectedAt !== null && !this.stopping.signal.aborted) {
          await this.gap(this.status.lastActivityAtMs ?? connectedAt, this.dropReason);
          this.outageAt = this.clock.now();
          // A brief subscribe/close loop still backs off; a stable minute resets it.
          if (this.clock.now() - connectedAt >= 60_000) backoff = 1000;
        }
        if (this.stopping.signal.aborted) break;
        const authWait = this.authRetryAt - this.clock.now();
        const wait = Math.max(backoff, authWait);
        this.status.state = authWait > 0 ? 'auth-error' : 'backoff';
        this.status.retryAtMs = this.clock.now() + wait;
        await this.clock.sleep(wait, this.stopping.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    } finally {
      if (this.outageAt !== null) await this.gap(this.outageAt, this.dropReason);
      this.status.state = 'stopped';
      this.status.retryAtMs = null;
    }
  }

  private async monitor(connection: UsageSubscription, signal: AbortSignal): Promise<void> {
    let pingAt = this.clock.now();
    let heartbeatAt = pingAt;
    while (!signal.aborted) {
      await this.clock.sleep(1000, signal);
      if (signal.aborted) break;
      const now = this.clock.now();
      if (now - (this.status.lastActivityAtMs ?? now) >= 40_000) {
        connection.close();
        break;
      }
      if (now - pingAt >= 30_000) {
        connection.ping();
        pingAt = now;
      }
      if (now - heartbeatAt >= 10_000) {
        // Waiting for disk here would also delay PING and silence detection.
        void this.writer.heartbeat(this.source.instanceId, now).catch(() => connection.close());
        heartbeatAt = now;
      }
      this.refreshLabels();
    }
  }
}
