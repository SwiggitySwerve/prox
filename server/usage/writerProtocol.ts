// Structured-clone contracts shared by sockets and the writer; no database imports.
import type { AccountLabel, IngestSource } from './types';
import type { CpampProgress, CpampReport } from './importCpamp';
import type { ExporterSnapshot } from './exporter';
import type { BackupReport } from './backup';

export const BULK_JOB_KINDS = ['import', 'reconcile', 'verify', 'backup', 'prune'] as const;
export type BulkJobKind = (typeof BULK_JOB_KINDS)[number];
export function isBulkJobKind(value: unknown): value is BulkJobKind {
  return typeof value === 'string' && BULK_JOB_KINDS.some((kind) => kind === value);
}
export interface BulkJobConfig {
  cpampPath?: string;
  backupConfigPath?: string;
  bytesPerSecond?: number;
}
export interface BulkJobReport {
  id: number;
  kind: BulkJobKind;
  state: 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
  startedAtMs: number;
  finishedAtMs: number | null;
  progress?: CpampProgress;
  result?:
    | { kind: 'cpamp'; report: CpampReport }
    | { kind: 'backup'; report: BackupReport }
    | { kind: 'prune'; report: { beforeMs: number; deleted: number; chunks: number } };
  error?: string;
  io: { bytesRead: number; bytesWritten: number; pauseSeconds: number; longPauses: number };
  lastBackupSuccessAtMs: number | null;
}

export interface UsagePayload {
  instance: string;
  payload: string;
  ingest: IngestSource;
  label?: AccountLabel;
}
export interface IngestGap {
  instance: string;
  fromMs: number;
  toMs: number;
  reason: 'stale-heartbeat' | 'subscription-dropped' | 'writer-overflow';
}
export interface ExporterConfig {
  rateBookPath?: string;
  clientAliasesPath?: string;
}
export interface WriterStatus {
  exporter?: ExporterSnapshot & {
    rate_book_error: boolean;
    client_alias_error: boolean;
    rate_book_loaded: boolean;
    client_aliases_loaded: boolean;
  };
  backlog: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  rawBufferFailures: number;
  gaps: number;
  job?: BulkJobReport | null;
}
export interface CollectorWriter {
  readonly backlog: number;
  enqueue(payload: UsagePayload): void;
  gap(gap: IngestGap): Promise<void>;
  heartbeat(instance: string, atMs: number): Promise<void>;
}
export type WriterRequest =
  | {
      id: number;
      kind: 'init';
      body: {
        events: string;
        raw: string | null;
        sources: string[];
        nowMs: number;
        jobs?: BulkJobConfig;
        exporter?: ExporterConfig;
      };
    }
  | { id: number; kind: 'live'; body: UsagePayload[] }
  | { id: number; kind: 'gap'; body: IngestGap }
  | { id: number; kind: 'heartbeat'; body: { instance: string; atMs: number } }
  | { id: number; kind: BulkJobKind; body: null }
  | { id: number; kind: 'cancel'; body: { jobId: number } }
  | { id: number; kind: 'job-status' | 'exporter'; body: null }
  | { id: number; kind: 'flush' | 'close'; body: null };
export type WriterReply =
  | { id: number; ok: true; body: WriterStatus }
  | { id: number; ok: false; body: { error: string; fatal: boolean } };
export const WRITER_HIGH_WATER = 50_000;
export const QUEUE_RETENTION_MS = 3_600_000;
