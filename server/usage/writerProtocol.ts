// Structured-clone contracts shared by sockets and the writer; no database imports.
import type { AccountLabel, IngestSource } from './types';

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
export interface WriterStatus {
  backlog: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  rawBufferFailures: number;
  gaps: number;
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
        rateBookPath?: string;
      };
    }
  | { id: number; kind: 'live'; body: UsagePayload[] }
  | { id: number; kind: 'gap'; body: IngestGap }
  | { id: number; kind: 'heartbeat'; body: { instance: string; atMs: number } }
  | { id: number; kind: 'flush' | 'close'; body: null };
export interface WriterReply {
  id: number;
  ok: boolean;
  body: WriterStatus | { error: string };
}
export const WRITER_HIGH_WATER = 50_000;
export const QUEUE_RETENTION_MS = 3_600_000;
