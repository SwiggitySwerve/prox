// Offline, read-only level-2 comparator. Never import this into either live server.
import { constants, Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpampPreconditions, type CpampSourceRow } from '../../server/usage/importCpamp';
import {
  cpampReference,
  CPAMP_PARITY_COLUMNS,
  type EventValues,
  type CpampEventReference,
  type NonCanonicalMetadata,
} from './cpampReference';
import { INGEST } from '../../server/usage/types';
import { DUAL_RUN_START } from './matrix';
import { diffValues, type Difference } from './compare';
import type { QueryGate } from './io';

export interface Interval {
  from_ms: number;
  to_ms: number;
  instance: string;
  reason: string;
}
export function validateIntervals(input: unknown): Interval[] {
  if (!Array.isArray(input)) throw new Error('Expected an array of CPAMP outage intervals');
  return input.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid outage interval');
    const r = row as Interval;
    if (
      !Number.isSafeInteger(r.from_ms) ||
      !Number.isSafeInteger(r.to_ms) ||
      r.from_ms >= r.to_ms ||
      typeof r.instance !== 'string' ||
      !r.instance.trim() ||
      typeof r.reason !== 'string' ||
      !r.reason.trim()
    )
      throw new Error('Invalid outage interval');
    return { from_ms: r.from_ms, to_ms: r.to_ms, instance: r.instance, reason: r.reason };
  });
}
export function openParityReader(path: string): Database {
  const uri = pathToFileURL(resolve(path));
  uri.searchParams.set('mode', 'ro');
  const db = new Database(uri.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  try {
    // No persistent pragma, migrations, temp files or mmap bypass of the byte governor.
    db.exec(
      'PRAGMA query_only=1; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA busy_timeout=1000'
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
interface TargetRow extends EventValues {
  seq: number;
  ingest: number;
}
const TARGET_COLUMNS = `e.seq, e.ingest, d.execution_id, e.ts_ms,
  (SELECT value FROM dim WHERE id=e.instance_id) AS instance,
  (SELECT value FROM dim WHERE id=e.provider_id) AS provider,
  (SELECT value FROM dim WHERE id=e.account_id) AS account,
  (SELECT value FROM dim WHERE id=e.account_label_id) AS account_label,
  (SELECT value FROM dim WHERE id=e.auth_file_id) AS auth_file_snapshot,
  d.fail_summary, d.header_trace_id,
  (SELECT value FROM dim WHERE id=e.api_key_id) AS api_key_hash,
  (SELECT value FROM dim WHERE id=e.model_id) AS model,
  (SELECT value FROM dim WHERE id=e.requested_model_id) AS requested_model,
  (SELECT value FROM dim WHERE id=e.billing_model_id) AS billing_model,
  (SELECT value FROM dim WHERE id=e.tier_id) AS tier,
  e.failed, e.status_code, e.latency_ms, e.ttft_ms, e.input_total, e.input_uncached,
  e.cache_read, e.cache_write, e.output_total, e.reasoning, e.total, e.usage_flags, e.record_kind`;
type IngestKind = keyof typeof INGEST;
const INGEST_NAMES = Object.fromEntries(
  Object.entries(INGEST).map(([kind, code]) => [code, kind])
) as Record<number, IngestKind>;
const ingestCounts = () => ({ subscribed: 0, drained: 0, imported: 0, replayed: 0 });
function completionTime(row: EventValues): number | null {
  if (row.latency_ms === null || !Number.isSafeInteger(row.latency_ms) || row.latency_ms <= 0)
    return null;
  const completed = row.ts_ms + row.latency_ms;
  return Number.isSafeInteger(completed) ? completed : null;
}
function completionOverlaps(row: EventValues, interval: Interval): boolean {
  const completed = completionTime(row);
  return (
    completed !== null &&
    row.instance === interval.instance &&
    interval.from_ms < interval.to_ms &&
    completed >= interval.from_ms &&
    completed < interval.to_ms
  );
}
const overlaps = (row: EventValues, interval: Interval) =>
  row.instance === interval.instance && row.ts_ms >= interval.from_ms && row.ts_ms < interval.to_ms;
export interface EventReport {
  from_ms: number;
  to_ms: number;
  cpamp_rows: number;
  prox_rows: number;
  matched: number;
  exact_matched: number;
  matched_by_ingest: Record<IngestKind, number>;
  reverse_only_omitted_by_ingest: Record<IngestKind, number>;
  cpamp_max_id: number;
  gaps: Interval[];
  preconditions: ReturnType<typeof cpampPreconditions>;
  windows_completed: number;
  complete: boolean;
}
export function createEventReport(fromMs: number, toMs: number): EventReport {
  return {
    from_ms: Math.min(toMs, Math.max(fromMs, DUAL_RUN_START)),
    to_ms: toMs,
    cpamp_rows: 0,
    prox_rows: 0,
    matched: 0,
    exact_matched: 0,
    matched_by_ingest: ingestCounts(),
    reverse_only_omitted_by_ingest: ingestCounts(),
    cpamp_max_id: 0,
    gaps: [],
    preconditions: cpampPreconditions(),
    windows_completed: 0,
    complete: false,
  };
}
/** Timestamp index is forced, all reads keyset-paged, every window <= five minutes. */
export async function compareEvents(
  source: Database,
  target: Database,
  fromMs: number,
  toMs: number,
  gate: QueryGate,
  emit: (difference: Difference) => void,
  outages: Interval[] = [],
  report?: EventReport
): Promise<EventReport> {
  const from = Math.max(fromMs, DUAL_RUN_START);
  const result = report ?? createEventReport(fromMs, toMs);
  if (from >= toMs) {
    result.complete = true;
    return result;
  }
  let gapFrom = from;
  let gapTo = toMs;
  const loadGaps = () =>
    gate.run(
      () =>
        target
          .query<Interval, [number, number]>(
            `
    SELECT instance, from_ms, to_ms, reason FROM ingest_gaps
    WHERE from_ms < ? AND to_ms > ? ORDER BY from_ms, id`
          )
          .all(gapTo, gapFrom),
      true
    );
  result.gaps = await loadGaps();
  const readSource = await gate.run(
    () =>
      source.query<CpampSourceRow, [number, number, number, number, number]>(`
    SELECT ${CPAMP_PARITY_COLUMNS} FROM usage_events INDEXED BY idx_usage_events_timestamp
    WHERE timestamp_ms >= ? AND timestamp_ms < ?
    AND (timestamp_ms > ? OR (timestamp_ms = ? AND id > ?))
    ORDER BY timestamp_ms, id LIMIT 1000`),
    true
  );
  const readTarget = await gate.run(
    () =>
      target.query<TargetRow, [number, number, number, number, number]>(`
    SELECT ${TARGET_COLUMNS} FROM events e JOIN event_detail d ON d.seq=e.seq AND d.ts_ms=e.ts_ms
    WHERE e.ts_ms >= ? AND e.ts_ms < ?
    AND (e.ts_ms > ? OR (e.ts_ms = ? AND e.seq > ?))
    ORDER BY e.ts_ms, e.seq LIMIT 1000`),
    true
  );
  const seen = new Set<string>();
  for (let start = from; start < toMs; start += 300_000) {
    const end = Math.min(toMs, start + 300_000);
    const expected = new Map<string | number, CpampEventReference | NonCanonicalMetadata>();
    const actual = new Map<string, TargetRow>();
    let timestamp = start,
      id = -1;
    for (;;) {
      const rows = await gate.run(() => readSource.all(start, end, timestamp, timestamp, id), true);
      for (const row of rows) {
        result.cpamp_rows++;
        result.cpamp_max_id = Math.max(result.cpamp_max_id, row.id);
        const event = cpampReference(row, result.preconditions, seen);
        if (!event)
          emit({
            class: 'unexplained',
            path: `events.cpamp-row-${row.id}`,
            cpamp: {
              id: row.id,
              timestamp_ms: row.timestamp_ms,
              error: 'unmappable or duplicate event',
            },
            prox: null,
          });
        else expected.set('error' in event ? row.id : event.execution_id, event);
      }
      if (rows.length < 1000) break;
      timestamp = Number(rows.at(-1)!.timestamp_ms);
      id = rows.at(-1)!.id;
    }
    timestamp = start;
    id = -1;
    for (;;) {
      const rows = await gate.run(() => readTarget.all(start, end, timestamp, timestamp, id), true);
      rows.forEach((row) => {
        result.prox_rows++;
        actual.set(row.execution_id, row);
      });
      if (rows.length < 1000) break;
      timestamp = rows.at(-1)!.ts_ms;
      id = rows.at(-1)!.seq;
    }
    // Completion can fall outside the requested START-time window. Read gap metadata
    // there too, without extending any CPAMP event scan or inferring an outage.
    const completions = [...expected.values()].flatMap((row) => {
      if ('error' in row || actual.has(row.execution_id)) return [];
      const point = completionTime(row);
      return point === null ? [] : [point];
    });
    const nextFrom = Math.min(gapFrom, ...completions.map((point) => point));
    const nextTo = Math.max(gapTo, ...completions.map((point) => point + 1));
    if (nextFrom !== gapFrom || nextTo !== gapTo) {
      gapFrom = nextFrom;
      gapTo = nextTo;
      result.gaps = await loadGaps();
    }
    for (const [key, row] of expected) {
      const execution = row.execution_id;
      const found = actual.get(execution);
      if ('error' in row) {
        emit({
          class: 'unexplained',
          path: `events.${execution || `cpamp-row-${key}`}.metadata`,
          cpamp: { id: row.id, timestamp_ms: row.timestamp_ms, error: row.error },
          prox: found ?? null,
        });
        actual.delete(execution);
        continue;
      }
      if (!found) {
        const gap = result.gaps.find((interval) => completionOverlaps(row, interval));
        emit({
          class: gap ? 'ingest-gap' : 'unexplained',
          path: `events.${execution}`,
          cpamp: row,
          prox: gap
            ? {
                absent: true,
                interval: gap,
                completed_ms: completionTime(row),
                tolerance_ms: 0,
              }
            : null,
        });
      } else {
        const values: Partial<TargetRow> = { ...found };
        delete values.seq;
        delete values.ingest;
        const { ttft_method, ...reference } = row;
        const differences = diffValues(reference, values, `events.${execution}`).map(
          (difference): Difference =>
            difference.path === `events.${execution}.ttft_ms` &&
            difference.cpamp === 0 &&
            difference.prox === null &&
            (ttft_method === 'unknown' || ttft_method === 'unavailable')
              ? { ...difference, class: 'ttft-zero-null' }
              : difference
        );
        const kind = INGEST_NAMES[found.ingest];
        if (!kind)
          differences.push({
            class: 'unexplained',
            path: `events.${execution}.ingest`,
            cpamp: { allowed: Object.values(INGEST) },
            prox: found.ingest,
          });
        differences.forEach(emit);
        if (!differences.some((difference) => difference.class === 'unexplained')) {
          result.matched++;
          result.matched_by_ingest[kind]++;
          if (!differences.length) result.exact_matched++;
        }
        actual.delete(execution);
      }
    }
    for (const [execution, row] of actual) {
      const kind = INGEST_NAMES[row.ingest];
      if (kind && row.ingest !== INGEST.subscribed) {
        result.reverse_only_omitted_by_ingest[kind]++;
        const outage =
          row.ingest === INGEST.drained
            ? outages.find((interval) => overlaps(row, interval))
            : undefined;
        if (outage)
          emit({
            class: 'drained-during-cpamp-outage',
            path: `events.${execution}`,
            cpamp: { absent: true, interval: outage },
            prox: row,
          });
        continue;
      }
      emit({ class: 'unexplained', path: `events.${execution}`, cpamp: null, prox: row });
    }
    result.windows_completed++;
  }
  result.complete = true;
  return result;
}
