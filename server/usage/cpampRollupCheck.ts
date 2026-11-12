// CPAMP's independent pricing rollup contract, read-only. No connections are opened here.
import type { Database } from 'bun:sqlite';

const HOUR_MS = 3_600_000;
const TABLE = 'usage_pricing_hourly_provider_rollups_v1';
// usagepricing/repository.go:upsertHourlyTableBatch counts all outcomes and providers.
// normalized cache reads include the compatible legacy cached counter; uncached input
// has no rollup column and cannot be independently reconstructed for partial history.
const COUNTERS = {
  rows: 'calls',
  input_total: 'input_tokens',
  output_total: 'output_tokens',
  reasoning: 'reasoning_tokens',
  cache_read: 'cache_read_tokens + cached_tokens',
  cache_write: 'cache_creation_tokens',
  total: 'total_tokens',
} as const;
const projection = Object.entries(COUNTERS)
  .map(([key, column]) => `CAST(coalesce(sum(${column}), 0) AS TEXT) AS ${key}`)
  .join(', ');
type Values = Record<keyof typeof COUNTERS, string>;
type State = {
  schema_version: number;
  structure_revision: string;
  status: string;
  coverage_event_id: number;
  min_bucket_ms: number | null;
  max_bucket_ms: number | null;
  last_error: string | null;
};
export interface RollupHourCheck {
  hourMs: number;
  revision: string;
  coverageEventId: number;
  cpamp: Values;
  prox: Values;
  equal: boolean;
}
export interface RollupCheck {
  available: boolean;
  complete: boolean;
  hours: RollupHourCheck[];
  mismatches: RollupHourCheck[];
  uncovered: { hourMs: number; reason: string }[];
}

/** Each metadata/page/hour query is one governed chunk, with short read snapshots. */
export async function checkCpampRollups(
  source: Database,
  target: ReadonlyMap<number, Readonly<Record<string, bigint>>>,
  sourceMaxIds: ReadonlyMap<number, number>,
  options: {
    verifiedMaxId: number;
    limited: boolean;
    nowMs: number;
    chunk: <T>(work: () => T) => Promise<T>;
  }
): Promise<RollupCheck> {
  const { chunk } = options;
  const hours = new Set([...sourceMaxIds.keys(), ...target.keys()]);
  const tables = await chunk(
    () =>
      new Set(
        source
          .query<{ name: string }, []>(
            `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
      '${TABLE}', 'usage_pricing_rollup_state', 'usage_archive_event_refs'
    )
  `
          )
          .all()
          .map((row) => row.name)
      )
  );
  const available = tables.has(TABLE) && tables.has('usage_pricing_rollup_state');
  const result: RollupCheck = {
    available,
    complete: false,
    hours: [],
    mismatches: [],
    uncovered: [],
  };
  if (!available) {
    result.uncovered = [...hours]
      .sort((a, b) => a - b)
      .map((hourMs) => ({ hourMs, reason: 'rollups-unavailable' }));
    return result;
  }
  const stateQuery = source.query<State, []>(`
    SELECT schema_version, structure_revision, status, coverage_event_id,
      min_bucket_ms, max_bucket_ms, last_error
    FROM usage_pricing_rollup_state WHERE rollup_name = 'pricing_v1'
  `);
  const initial = await chunk(() => stateQuery.get());
  if (initial) {
    // Include rollup-only hours: otherwise a whole hour absent from both raw stores could pass.
    const knownHours = [...hours];
    const from = options.limited
      ? knownHours.length
        ? Math.min(...knownHours)
        : 0
      : -Number.MAX_SAFE_INTEGER;
    const to = options.limited
      ? knownHours.length
        ? Math.max(...knownHours) + HOUR_MS
        : 0
      : Number.MAX_SAFE_INTEGER;
    let after = from - 1;
    while (after < to) {
      const buckets = await chunk(() =>
        source
          .query<{ bucket_ms: number }, [string, number, number]>(
            `
        SELECT DISTINCT bucket_ms FROM ${TABLE}
        WHERE structure_revision = ? AND bucket_ms > ? AND bucket_ms < ?
        ORDER BY bucket_ms LIMIT 1000
      `
          )
          .all(initial.structure_revision, after, to)
      );
      for (const bucket of buckets) hours.add(bucket.bucket_ms);
      if (buckets.length < 1000) break;
      after = buckets[buckets.length - 1].bucket_ms;
    }
  }
  for (const hourMs of [...hours].sort((a, b) => a - b)) {
    await chunk(() =>
      source
        .transaction(() => {
          const state = stateQuery.get();
          let reason: string | undefined;
          if (options.limited) reason = 'limited-source-pass';
          else if (hourMs + HOUR_MS > options.nowMs) reason = 'open-hour';
          else if (!state || state.schema_version !== 1 || !state.structure_revision)
            reason = 'rollup-state-unavailable';
          else if (state.structure_revision !== initial?.structure_revision)
            reason = 'rollup-revision-changed';
          else if (!['ready', 'catching_up'].includes(state.status) || state.last_error)
            reason = 'rollup-not-ready';
          else if (state.coverage_event_id > options.verifiedMaxId)
            reason = 'rollup-ahead-of-source';
          else if (state.coverage_event_id < (sourceMaxIds.get(hourMs) ?? 0))
            reason = 'rollup-behind-hour';
          else if (
            state.min_bucket_ms === null ||
            state.max_bucket_ms === null ||
            hourMs < state.min_bucket_ms ||
            hourMs > state.max_bucket_ms
          )
            reason = 'outside-rollup-range';
          // A rebuilt pricing cache can contain retained archive rows no longer in usage_events.
          if (
            !reason &&
            tables.has('usage_archive_event_refs') &&
            source
              .query<{ present: number }, [number, number]>(
                `
        SELECT EXISTS(SELECT 1 FROM usage_archive_event_refs
          WHERE timestamp_ms >= ? AND timestamp_ms < ? AND raw_deleted_at_ms IS NOT NULL) AS present
      `
              )
              .get(hourMs, hourMs + HOUR_MS)!.present
          )
            reason = 'archived-source-hour';
          if (reason) {
            result.uncovered.push({ hourMs, reason });
            return;
          }
          const cpamp = source
            .query<Values, [string, number]>(
              `
        SELECT ${projection} FROM ${TABLE} WHERE structure_revision = ? AND bucket_ms = ?
      `
            )
            .get(state!.structure_revision, hourMs)!;
          const prox = Object.fromEntries(
            Object.keys(COUNTERS).map((key) => [key, String(target.get(hourMs)?.[key] ?? 0n)])
          ) as Values;
          const hour = {
            hourMs,
            revision: state!.structure_revision,
            coverageEventId: state!.coverage_event_id,
            cpamp,
            prox,
            equal: Object.keys(COUNTERS).every(
              (key) => cpamp[key as keyof Values] === prox[key as keyof Values]
            ),
          };
          result.hours.push(hour);
          if (!hour.equal) result.mismatches.push(hour);
        })
        .deferred()
    );
  }
  result.complete = !options.limited && initial !== null && result.uncovered.length === 0;
  return result;
}
