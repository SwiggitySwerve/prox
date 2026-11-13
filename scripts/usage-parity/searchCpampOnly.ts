// Evidence for the search-cpamp-only rule: which CPAMP events match a search term only through
// search-document structure that Prox does not have. Prox searches stored fields one by one;
// CPAMP searches one document of fields joined by char(31) for events its monitoring projection
// covers (event ID up to the projection's coverage), and the fields one by one for newer events
// (usageevent/analytics.go projectedSearchCondition). The difference has two sources: fields
// Prox never stores, and, for covered events, a `%` or `_` wildcard bridging two fields.
// Read-only; the CPAMP handle comes from openParityReader.
import type { Database } from 'bun:sqlite';
import type { UsageAnalyticsQuery } from '../../server/usage/validate';

/**
 * CPAMP's search document is the lowercase fields of usageprojection.SearchColumns joined by
 * char(31), commit 52b12b45 of CPA-Manager-Plus. A document of any other shape is not
 * understood, so no event is ever claimed from it.
 */
export const SEARCH_SEGMENTS = 29;
/**
 * Fields in that document that Prox deliberately does not store (server/usage/RULES.md: fail
 * bodies, response headers and credential files; the event hash is CPAMP's own identity).
 * Every other field has a stored counterpart, so a match there that Prox misses stays a failure.
 */
export const CPAMP_ONLY_SEGMENTS: ReadonlyMap<number, string> = new Map([
  [1, 'event_hash'],
  [18, 'auth_file_snapshot'],
  [24, 'fail_summary'],
  [28, 'header_trace_id'],
]);

/** SQLite's LIKE without ESCAPE: `%` any run, `_` one character, everything else literal. */
export function likePattern(pattern: string): RegExp {
  let source = '';
  for (const char of pattern)
    source +=
      char === '%'
        ? '[^]*'
        : char === '_'
          ? '[^]'
          : /[a-z]/i.test(char) // ASCII only, as SQLite folds it; ü and Ü stay different
            ? `[${char.toLowerCase()}${char.toUpperCase()}]`
            : char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`^${source}$`, 'u');
}
interface Candidate {
  id: number;
  text: string;
}
// One read of CPAMP per range serves every term and filter combination of the matrix.
const ranges = new WeakMap<Database, Map<string, Candidate[]>>();
function documents(cpamp: Database, from: number, to: number): Candidate[] {
  const cache = ranges.get(cpamp) ?? new Map<string, Candidate[]>();
  ranges.set(cpamp, cache);
  const key = `${from}:${to}`;
  let rows = cache.get(key);
  if (!rows) {
    rows = cpamp
      .query<Candidate, [number, number]>(
        `SELECT event_id AS id, search_text AS text FROM usage_monitoring_event_projection_v1
         WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY event_id`
      )
      .all(from, to);
    cache.set(key, rows);
  }
  return rows;
}
const identities = new WeakMap<Database, Map<number, string>>();
/**
 * The highest event ID the CPAMP projection covers right now. Without the table (an older or
 * synthetic database) nothing is covered and every event is matched field by field.
 */
export function projectionCoverage(cpamp: Database): number {
  try {
    return Number(
      cpamp
        .query<{ covered: number | null }, []>(
          `SELECT max(coverage_event_id) AS covered FROM usage_monitoring_rollup_state
           WHERE rollup_name = 'projection_v1' AND schema_version = 1 AND status <> 'clearing'`
        )
        .get()?.covered ?? 0
    );
  } catch {
    return 0;
  }
}
/**
 * Execution IDs of the events in [from_ms, to_ms) that CPAMP matches while none of the fields
 * Prox can search matches the term on its own. CPAMP matches an event covered by its projection
 * through the whole document and a newer one field by field, so a wildcard bridging two fields
 * counts only for a covered event. `covered` defaults to the projection's current coverage; a
 * run that reproduces older responses passes the coverage those responses had. Returns null
 * when the proof is not available: an unexpected document layout or an event without an
 * execution ID.
 */
export function cpampOnlySearchExecutions(
  cpamp: Database,
  q: Pick<UsageAnalyticsQuery, 'from_ms' | 'to_ms' | 'search'>,
  covered = projectionCoverage(cpamp)
): string[] | null {
  const term = q.search?.trim().toLowerCase();
  if (!term) return [];
  const pattern = likePattern(`%${term}%`);
  const only: number[] = [];
  for (const row of documents(cpamp, q.from_ms, q.to_ms)) {
    const segments = row.text.split('\x1f');
    if (segments.length !== SEARCH_SEGMENTS) return null;
    // A covered event matches through the whole document, a newer one through a single field.
    const matched =
      row.id <= covered ? pattern.test(row.text) : segments.some((segment) => pattern.test(segment));
    if (!matched) continue;
    if (!segments.some((segment, i) => !CPAMP_ONLY_SEGMENTS.has(i) && pattern.test(segment)))
      only.push(row.id);
  }
  const cache = identities.get(cpamp) ?? new Map<number, string>();
  identities.set(cpamp, cache);
  const identity = cpamp.query<{ execution_id: unknown }, [number]>(
    `SELECT json_extract(CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END,
       '$.execution_id') AS execution_id FROM usage_events WHERE id = ?`
  );
  const executions: string[] = [];
  for (const id of only) {
    let execution = cache.get(id);
    if (execution === undefined) {
      const value = identity.get(id)?.execution_id;
      if (typeof value !== 'string' || !value.trim()) return null;
      execution = value.trim();
      cache.set(id, execution);
    }
    executions.push(execution);
  }
  return executions;
}
