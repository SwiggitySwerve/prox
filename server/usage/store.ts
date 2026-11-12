// The only module of the usage service that opens SQLite. Import it from the writer worker and
// the query workers only: never from a thread that owns sockets (RULES.md).
import { Database, type Statement } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { INGEST } from './types';
import { gzipSync } from 'node:zlib';
import {
  META_TABLE_SQL,
  RAW_SCHEMA_SQL,
  READER_PRAGMAS_SQL,
  USAGE_MIGRATIONS,
  WRITER_PRAGMAS_SQL,
} from './schema';
import { HOUR_MS } from './aggregate';
import { rebuildNextHour } from './rollup';
import type { RateBook } from './rates';
import type { IngestGap } from './writerProtocol';
import type {
  DimKind,
  EventSession,
  IngestItem,
  IngestSource,
  InsertResult,
  NormalizedEvent,
  RejectReason,
  SanitizedPayload,
} from './types';

/** The one mapping from event dictionary columns to their owning dimension kind. */
const EVENT_DIMENSIONS: Record<string, DimKind> = {
  instance_id: 'instance',
  provider_id: 'provider',
  model_id: 'model',
  requested_model_id: 'model',
  billing_model_id: 'model',
  response_model_id: 'model',
  tier_id: 'tier',
  timing_id: 'timing',
  account_id: 'account',
  account_label_id: 'account_label',
  api_key_id: 'api_key',
  user_agent_id: 'user_agent',
  client_ip_id: 'client_ip',
  path_id: 'path',
  method_id: 'method',
  effort_id: 'effort',
  executor_id: 'executor',
  requested_tier_id: 'tier',
  effective_tier_id: 'tier',
  auth_index_id: 'auth_index',
};

export type ImportValues = Record<string, string | number | null>;
export interface EventCursor {
  tsMs: number;
  seq: number;
}
export interface ImportDifference {
  executionId: string;
  field: string;
  live: string | null;
  imported: string | null;
}
export interface ImportInspection {
  stored: ImportValues | null;
  differences: ImportDifference[];
}

const EVENT_COLUMNS = [
  'ts_ms',
  'seq',
  'instance_id',
  'provider_id',
  'model_id',
  'requested_model_id',
  'billing_model_id',
  'response_model_id',
  'tier_id',
  'failed',
  'status_code',
  'latency_ms',
  'ttft_ms',
  'timing_id',
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'output_total',
  'reasoning',
  'total',
  'usage_flags',
  'record_kind',
  'stream',
  'account_id',
  'account_label_id',
  'api_key_id',
  'user_agent_id',
  'client_ip_id',
  'path_id',
  'method_id',
  'effort_id',
  'executor_id',
  'requested_tier_id',
  'effective_tier_id',
  'session_id',
  'auth_index_id',
  'ingest',
] as const;
const DETAIL_COLUMNS = [
  'seq',
  'execution_id',
  'ts_ms',
  'request_id',
  'parent_execution_id',
  'session_id',
  'parent_session_id',
  'trace_id',
  'upstream_start_ms',
  'first_response_ms',
  'first_content_ms',
  'recorded_ms',
  'ingested_at_ms',
] as const;
type Row<Columns extends readonly string[]> = Record<Columns[number], string | number | null>;

const insertSql = (table: string, columns: readonly string[]) =>
  `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `$${c}`).join(', ')})`;

function openWritable(path: string, schemaSql: string): Database {
  if (path !== ':memory:') {
    const file = resolve(path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
  }
  const db = new Database(path, { create: true, strict: true });
  db.exec(WRITER_PRAGMAS_SQL);
  db.exec(schemaSql);
  return db;
}

/**
 * Bring usage.sqlite forward, one migration at a time. A migration and its version number
 * commit together, so a failure leaves the database at the last version that fully applied.
 */
export function migrateUsageDatabase(
  db: Database,
  migrations: readonly string[] = USAGE_MIGRATIONS
): void {
  db.exec(META_TABLE_SQL);
  const stored = db
    .query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get();
  const version = Number(stored?.value ?? 0);
  if (version > migrations.length) {
    throw new Error(
      `usage database has schema version ${version}; this build reads up to ${migrations.length}`
    );
  }
  for (let next = version; next < migrations.length; next += 1) {
    db.transaction(() => {
      db.exec(migrations[next]);
      db.query(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      ).run(String(next + 1));
    }).immediate();
  }
}

/** A read-only connection for a query worker. The writer must have created the file. */
export function openUsageReader(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec(READER_PRAGMAS_SQL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The single write connection of usage.sqlite, and of the raw payload buffer beside it.
 * Inserts are idempotent on `execution_id`; a stored row is never updated.
 */
export class UsageStore {
  rawBufferFailures = 0;
  private readonly db: Database;
  private readonly raw: Database | null;
  private readonly dims = new Map<string, number>();
  private nextSeq: number;
  private readonly insertDim: Statement;
  private readonly selectDim: Statement<{ id: number }, [string, string]>;
  private readonly insertSession: Statement;
  private readonly selectSession: Statement<{ id: number }, [string]>;
  private readonly adoptParent: Statement;
  private readonly insertDetail: Statement;
  private readonly insertEvent: Statement;
  private readonly insertAll: {
    immediate(items: readonly IngestItem[], ingest: IngestSource): Stored[];
  };

  /** `raw: null` runs without the raw payload buffer (imported history brings no payloads). */
  constructor(
    paths: { events: string; raw: string | null },
    private readonly now: () => number = Date.now
  ) {
    this.db = openWritable(paths.events, META_TABLE_SQL);
    try {
      migrateUsageDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.nextSeq = Number(this.getMeta('next_seq') ?? 1);
    this.raw = paths.raw === null ? null : openWritable(paths.raw, RAW_SCHEMA_SQL);

    this.insertDim = this.db.query(
      'INSERT INTO dim (kind, value) VALUES (?, ?) ON CONFLICT (kind, value) DO NOTHING'
    );
    this.selectDim = this.db.query('SELECT id FROM dim WHERE kind = ? AND value = ?');
    this.insertSession = this.db.query(
      'INSERT INTO session (uuid, parent_id, derived) VALUES (?, ?, ?) ON CONFLICT (uuid) DO NOTHING'
    );
    this.selectSession = this.db.query('SELECT id FROM session WHERE uuid = ?');
    this.adoptParent = this.db.query(
      'UPDATE session SET parent_id = ? WHERE id = ? AND parent_id IS NULL'
    );
    this.insertDetail = this.db.query(
      `${insertSql('event_detail', DETAIL_COLUMNS)} ON CONFLICT (execution_id) DO NOTHING`
    );
    this.insertEvent = this.db.query(insertSql('events', EVENT_COLUMNS));
    this.insertAll = this.db.transaction((items: readonly IngestItem[], ingest: IngestSource) => {
      const stored: Stored[] = [];
      const dirtyHours = new Set<number>();
      for (const item of items) {
        const seq = this.nextSeq;
        // The identity check and the write are one statement: a known execution_id writes nothing.
        if (this.insertDetail.run(this.detailRow(item.event, seq)).changes === 0) continue;
        this.nextSeq += 1;
        this.insertEvent.run(this.eventRow(item.event, seq, ingest));
        stored.push({ seq, item });
        dirtyHours.add(Math.floor(item.event.tsMs / HOUR_MS) * HOUR_MS);
      }
      const markDirty = this.db.query(`INSERT INTO usage_hour_state (hour_ms) VALUES (?)
        ON CONFLICT (hour_ms) DO UPDATE SET dirty = 1`);
      for (const hour of dirtyHours) markDirty.run(hour);
      this.setMeta('next_seq', String(this.nextSeq));
      return stored;
    });
  }

  /** Store the events that are not yet known, in one transaction. */
  insert(items: readonly IngestItem[], ingest: IngestSource): InsertResult {
    const firstSeq = this.nextSeq;
    let stored: Stored[];
    try {
      stored = this.insertAll.immediate(items, ingest);
    } catch (error) {
      // The rollback also undid the sequence numbers and dictionary rows handed out above.
      this.nextSeq = firstSeq;
      this.dims.clear();
      throw error;
    }
    this.writeRaw(() => {
      if (!this.raw) return;
      const insertPayload = this.raw.query(
        'INSERT INTO payloads (seq, ts_ms, dropped_keys, payload) VALUES (?, ?, ?, ?)'
      );
      this.raw.transaction(() => {
        for (const { seq, item } of stored) {
          if (!item.raw) continue;
          insertPayload.run(seq, item.event.tsMs, item.raw.droppedKeys, gzipSync(item.raw.json));
        }
      })();
    });
    return { inserted: stored.length, duplicates: items.length - stored.length };
  }

  /** One bounded maintenance job; imports use insert(), so their hours invalidate atomically. */
  rebuildNextHour(book: RateBook, nowMs = this.now()) {
    return rebuildNextHour(this.db, book, nowMs);
  }

  /** Keep what can be kept of a payload that did not become an event. */
  recordRejected(reason: RejectReason, raw: SanitizedPayload | null): void {
    this.writeRaw(() =>
      this.raw
        ?.query(
          'INSERT INTO rejects (received_at_ms, reason, dropped_keys, payload) VALUES (?, ?, ?, ?)'
        )
        .run(this.now(), reason, raw?.droppedKeys ?? null, raw ? gzipSync(raw.json) : null)
    );
  }

  /** Drop buffered payloads and rejects older than `beforeMs`. Events are not touched. */
  pruneRawBefore(beforeMs: number): number {
    if (!this.raw) return 0;
    const payloads = this.raw.query('DELETE FROM payloads WHERE ts_ms < ?').run(beforeMs);
    const rejects = this.raw.query('DELETE FROM rejects WHERE received_at_ms < ?').run(beforeMs);
    return payloads.changes + rejects.changes;
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  /** Gaps and heartbeats share the event store's sole writer connection. */
  recordGap(gap: IngestGap): void {
    this.db
      .query(
        'INSERT INTO ingest_gaps (instance, from_ms, to_ms, reason, missed) VALUES (?, ?, ?, ?, NULL)'
      )
      .run(gap.instance, gap.fromMs, gap.toMs, gap.reason);
  }

  gapCount(): number {
    return this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM ingest_gaps').get()!
      .count;
  }

  private writeRaw(write: () => unknown): void {
    try {
      write();
    } catch {
      // The event transaction has already committed. Retrying it cannot restore the raw buffer.
      this.rawBufferFailures += 1;
      console.error('Usage raw-buffer write failed; committed events were retained');
    }
  }

  /** Compare through the store contract; callers never reach into the write connection. */
  inspectImportEvents(events: readonly NormalizedEvent[]): ImportInspection[] {
    const projection = Object.keys(EVENT_DIMENSIONS).map(
      (column) => `${column}_dim.value AS ${column}`
    );
    const joins = Object.keys(EVENT_DIMENSIONS).map(
      (column) => `LEFT JOIN dim ${column}_dim ON ${column}_dim.id = e.${column}`
    );
    const select = this.db.query<ImportValues, [string]>(`
      SELECT e.*, d.*, ${projection.join(', ')}, s.uuid AS session_id
      FROM event_detail d JOIN events e ON e.ts_ms = d.ts_ms AND e.seq = d.seq
      ${joins.join(' ')} LEFT JOIN session s ON s.id = e.session_id
      WHERE d.execution_id = ?
    `);
    return events.map((event) => {
      const stored = select.get(event.executionId);
      if (!stored) return { stored: null, differences: [] };
      const expected = {
        ...this.eventRow(event, 0, INGEST.imported, false),
        ...this.detailRow(event, 0),
      };
      // The joined session UUID and the per-event detail UUID agree for valid stored events.
      const differences: ImportDifference[] = [];
      for (const [field, value] of Object.entries(expected)) {
        if (field === 'seq' || field === 'ingest' || field === 'ingested_at_ms') continue;
        if (stored[field] !== value) {
          differences.push({
            executionId: event.executionId,
            field,
            live: stored[field] === null ? null : String(stored[field]),
            imported: value === null ? null : String(value),
          });
        }
      }
      return { stored, differences };
    });
  }

  /** Freeze the end of an independent, bounded scan of the target event cohort. */
  verificationBoundary(fromMs: number, toMs: number): EventCursor | null {
    return this.db
      .query<EventCursor, [number, number]>(
        `
      SELECT ts_ms AS tsMs, seq FROM events WHERE ts_ms >= ? AND ts_ms < ?
      ORDER BY ts_ms DESC, seq DESC LIMIT 1
    `
      )
      .get(fromMs, toMs);
  }

  /** Scan the primary key in bounded pages, including live rows so sparse imports cannot
   * turn one chunk into a scan of an unbounded live table. The caller filters ingest. */
  readVerificationChunk(
    after: EventCursor,
    through: EventCursor,
    fromMs: number,
    toMs: number
  ): ImportValues[] {
    return this.db
      .query<ImportValues, [number, number, number, number, number, number]>(
        `
      SELECT e.*, d.execution_id FROM events e
      LEFT JOIN event_detail d ON d.seq = e.seq AND d.ts_ms = e.ts_ms
      WHERE (e.ts_ms, e.seq) > (?, ?) AND (e.ts_ms, e.seq) <= (?, ?)
        AND e.ts_ms >= ? AND e.ts_ms < ?
      ORDER BY e.ts_ms, e.seq LIMIT 1000
    `
      )
      .all(after.tsMs, after.seq, through.tsMs, through.seq, fromMs, toMs);
  }

  /** Rows, deduplicated conflicts and the source cursor are one crash-safe commit. */
  importChunk(
    events: readonly NormalizedEvent[],
    lastId: number
  ): InsertResult & { conflicts: number } {
    const firstSeq = this.nextSeq;
    try {
      return this.db
        .transaction(() => {
          const inspections = this.inspectImportEvents(events);
          const conflict = this.db.query(`
          INSERT INTO import_conflicts (execution_id, field, live, imported, seen_at_ms)
          SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM import_conflicts
            WHERE execution_id = ? AND field = ? AND live IS ? AND imported IS ?
          )
        `);
          let conflicts = 0;
          for (const inspection of inspections) {
            for (const diff of inspection.differences) {
              conflicts += conflict.run(
                diff.executionId,
                diff.field,
                diff.live,
                diff.imported,
                this.now(),
                diff.executionId,
                diff.field,
                diff.live,
                diff.imported
              ).changes;
            }
          }
          const stored = this.insertAll.immediate(
            events.map((event) => ({ event, raw: null })),
            INGEST.imported
          );
          this.setMeta('import:cpamp:last_id', String(lastId));
          return { inserted: stored.length, duplicates: events.length - stored.length, conflicts };
        })
        .immediate();
    } catch (error) {
      this.nextSeq = firstSeq;
      this.dims.clear();
      throw error;
    }
  }

  /** Logical database size includes pages not yet checkpointed from WAL. */
  databaseSizeBytes(): number {
    const pages = this.db.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count;
    const size = this.db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
    return pages * size;
  }

  /** Caller supplies a new path on tmpfs. This must run as a serialized writer job. */
  vacuumInto(path: string): void {
    this.db.query('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.raw?.close();
    this.db.close();
  }

  private dim(kind: DimKind, value: string): number {
    const key = `${kind}\u0000${value}`;
    let id = this.dims.get(key);
    if (id === undefined) {
      this.insertDim.run(kind, value);
      id = this.selectDim.get(kind, value)!.id;
      this.dims.set(key, id);
    }
    return id;
  }

  /** One row per session uuid. The first parent a session is reported with stays its parent. */
  private session(session: EventSession | null, parent: EventSession | null): number | null {
    if (!session) return null;
    const parentId = this.session(parent, null);
    this.insertSession.run(session.uuid, parentId, session.derived ? 1 : 0);
    const { id } = this.selectSession.get(session.uuid)!;
    // The row may be older than this report: a session first seen as another one's parent.
    if (parentId !== null) this.adoptParent.run(parentId, id);
    return id;
  }

  private eventRow(
    event: NormalizedEvent,
    seq: number,
    ingest: IngestSource,
    intern = true
  ): Row<typeof EVENT_COLUMNS> {
    const row: Row<typeof EVENT_COLUMNS> = {
      ts_ms: event.tsMs,
      seq,
      instance_id: event.instance,
      provider_id: event.provider,
      model_id: event.model,
      requested_model_id: event.requestedModel,
      billing_model_id: event.billingModel,
      response_model_id: event.responseModel,
      tier_id: event.tier,
      failed: event.failed ? 1 : 0,
      status_code: event.statusCode,
      latency_ms: event.latencyMs,
      ttft_ms: event.ttftMs,
      timing_id: event.timingMethod,
      input_total: event.tokens.inputTotal,
      input_uncached: event.tokens.inputUncached,
      cache_read: event.tokens.cacheRead,
      cache_write: event.tokens.cacheWrite,
      output_total: event.tokens.outputTotal,
      reasoning: event.tokens.reasoning,
      total: event.tokens.total,
      usage_flags: event.usageFlags,
      record_kind: event.recordKind,
      stream: event.stream === null ? null : event.stream ? 1 : 0,
      account_id: event.account,
      account_label_id: event.accountLabel,
      api_key_id: event.apiKeyHash,
      user_agent_id: event.userAgent,
      client_ip_id: event.clientIp,
      path_id: event.path,
      method_id: event.method,
      effort_id: event.effort,
      executor_id: event.executor,
      requested_tier_id: event.requestedTier,
      effective_tier_id: event.effectiveTier,
      session_id: intern
        ? this.session(event.session, event.parentSession)
        : (event.session?.uuid ?? null),
      auth_index_id: event.authIndex,
      ingest,
    };
    if (intern) {
      for (const [column, kind] of Object.entries(EVENT_DIMENSIONS)) {
        const key = column as keyof typeof row;
        const value = row[key] as string | null;
        row[key] = value === null ? null : this.dim(kind, value);
      }
    }
    return row;
  }

  private detailRow(event: NormalizedEvent, seq: number): Row<typeof DETAIL_COLUMNS> {
    return {
      seq,
      execution_id: event.executionId,
      ts_ms: event.tsMs,
      request_id: event.requestId,
      parent_execution_id: event.parentExecutionId,
      session_id: event.session?.uuid ?? null,
      parent_session_id: event.parentSession?.uuid ?? null,
      trace_id: event.traceId,
      upstream_start_ms: event.timing?.upstreamStartMs ?? null,
      first_response_ms: event.timing?.firstResponseMs ?? null,
      first_content_ms: event.timing?.firstContentMs ?? null,
      recorded_ms: event.timing?.recordedMs ?? null,
      ingested_at_ms: this.now(),
    };
  }
}

type Stored = { seq: number; item: IngestItem };
