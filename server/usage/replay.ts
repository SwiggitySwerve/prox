// Validation of the proxy's numbered usage-log protocol. No persistence or sockets.
import type { UsageCursor } from './writerProtocol';

const sequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function usageCursor(record: Record<string, unknown>): UsageCursor | undefined {
  return typeof record.boot_id === 'string' &&
    record.boot_id.length > 0 &&
    sequence(record.queue_seq) &&
    record.queue_seq > 0
    ? { bootId: record.boot_id, queueSeq: record.queue_seq }
    : undefined;
}

export interface ReplayPage {
  bootId: string;
  oldestSeq: number;
  nextSeq: number;
  records: { queueSeq: number; payload: unknown }[];
}

export function parseReplayPage(value: unknown, after: number): ReplayPage {
  const invalid = () => new Error('Invalid usage replay response');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const page = value as Record<string, unknown>;
  if (
    typeof page.boot_id !== 'string' ||
    !page.boot_id ||
    !sequence(page.oldest_seq) ||
    page.oldest_seq < 1 ||
    !sequence(page.next_seq) ||
    !Array.isArray(page.records) ||
    page.records.length > 1000
  )
    throw invalid();
  let previous = after;
  const records = page.records.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const record = value as Record<string, unknown>;
    if (
      !sequence(record.queue_seq) ||
      record.queue_seq <= previous ||
      record.queue_seq < (page.oldest_seq as number) ||
      !('payload' in record)
    )
      throw invalid();
    previous = record.queue_seq;
    return { queueSeq: record.queue_seq, payload: record.payload };
  });
  if (page.next_seq !== Math.max(previous, (page.oldest_seq as number) - 1)) throw invalid();
  return {
    bootId: page.boot_id,
    oldestSeq: page.oldest_seq as number,
    nextSeq: page.next_seq as number,
    records,
  };
}
