// Read-side analytics owner. Called inside a worker, with one immutable rate-book snapshot.
import type { Database } from 'bun:sqlite';
import type { AnalyticsMetrics, AnalyticsResponse } from '../../src/domain/analytics/types';
import { readAnalyticsGroups } from './rollupRead';
import { HOUR_MS, DAY_MS, type AggregateRow } from './aggregate';
import { sourceAttribution } from './parity';
import { analyticsCosts } from './analyticsPricing';
import { buildRateInventory } from './pricing';
import { queryFilter, requestPage, type Dimension } from './search';
import { KNOWN_PROVIDERS } from './types';
import type { RateBookState } from './rates';
import type { UsageAnalyticsQuery } from './validate';

export const COVERAGE_LIMITATIONS = [
  'Retained usage events are not a complete ingress or client-outcome ledger.',
  'Costs are estimated API-equivalent subtotals at current configured rates; unknown measurement presence and unsupported components remain partial.',
  'Legacy numeric zero is not proof of reported zero. Aggregate usage presence is unknown; missing measurements remain included in retained-event counts.',
  'Known supplementary records are excluded from counts, cost and detail because overlap is unresolved. Legacy record kinds remain unknown; counts are retained primary events, not verified inbound requests.',
  'Historical canonical output and effective tiers are not rewritten; older Gemini output may omit thoughts.',
  'Output speed uses output tokens divided by full execution duration. TTFT methods may differ; no generation-time subtraction is performed.',
];

function emptyMetrics(): AnalyticsMetrics {
  return {
    calls: 0,
    success_calls: 0,
    failure_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    uncached_input_tokens: 0,
    average_latency_ms: null,
    p95_latency_ms: null,
    p95_ttft_ms: null,
    cost: { usd: null, status: 'unavailable', reasons: ['no-retained-events'] },
  };
}
class Metrics {
  value = emptyMetrics();
  private latencySum = 0;
  private latencyCount = 0;
  add(row: AggregateRow) {
    const v = this.value;
    v.calls += row.calls;
    v.failure_calls += row.failures;
    v.success_calls += row.calls - row.failures;
    v.input_tokens += row.input_total;
    v.output_tokens += row.output_total;
    v.cache_read_tokens += row.cache_read;
    v.cache_creation_tokens += row.cache_write;
    v.reasoning_tokens += row.reasoning;
    v.total_tokens += row.total;
    v.uncached_input_tokens! += row.input_uncached;
    this.latencySum += row.latency_sum;
    this.latencyCount += row.latency_count;
    v.average_latency_ms = this.latencyCount ? this.latencySum / this.latencyCount : null;
  }
}
function group(map: Map<number, Metrics>, key: number): Metrics {
  let metrics = map.get(key);
  if (!metrics) {
    metrics = new Metrics();
    map.set(key, metrics);
  }
  return metrics;
}
export interface AnalyticsReadOptions {
  now?: () => number;
  /** Internal benchmark observer; never serialized in an AnalyticsResponse. */
  onPhase?: (phase: string) => void;
  /** Boundary observer for deterministic concurrent-write regression tests. Runs in the snapshot. */
  afterAggregate?: () => void;
  checkDeadline?: () => void;
}
export function queryAnalytics(
  db: Database,
  q: UsageAnalyticsQuery,
  rates: RateBookState,
  options: AnalyticsReadOptions = {}
): AnalyticsResponse {
  const book = rates.book ?? { version: 1, models: {} };
  const check = options.checkDeadline ?? (() => {});
  // BEGIN DEFERRED pins the snapshot on the first SELECT, before any response component reads.
  return db
    .transaction((): AnalyticsResponse => {
      check();
      const dims = db.query<Dimension, []>('SELECT id, kind, value FROM dim').all();
      const names = new Map(dims.map((d) => [d.id, d.value]));
      const filter = queryFilter(db, q, dims);
      const bucketSize = q.granularity === 'day' ? DAY_MS : HOUR_MS;
      const { rows, latency, coverageRows } = readAnalyticsGroups(
        db,
        q,
        filter,
        dims,
        book,
        bucketSize,
        (options.now ?? Date.now)(),
        check,
        options.onPhase
      );
      options.afterAggregate?.();
      check();
      const ranks = latency.result();
      check();
      options.onPhase?.('percentiles');
      const page = requestPage(db, q, filter, names, book);
      options.onPhase?.('request-page');
      const summary = new Metrics();
      const timeline = new Map<number, Metrics>();
      const models = new Map<number, Metrics>();
      const providers = new Map<number, Metrics>();
      const observed = new Map<string, { provider: string; id: string }>();
      for (const row of rows) {
        const model = names.get(row.model_id)!;
        const provider = names.get(row.provider_id)!;
        summary.add(row);
        group(timeline, row.bucket).add(row);
        group(models, row.model_id).add(row);
        group(providers, row.provider_id).add(row);
        observed.set(`${provider}\0${model}`, { provider, id: model });
      }

      const costs = analyticsCosts(rows, names, book);
      summary.value.cost = costs.summary;
      for (const [id, metrics] of models) metrics.value.cost = costs.models.get(id)!;
      for (const [id, metrics] of providers) metrics.value.cost = costs.providers.get(id)!;
      for (const [id, metrics] of timeline) metrics.value.cost = costs.buckets.get(id)!;
      options.onPhase?.('pricing');

      // Selectors ignore provider/model/outcome, while retaining the range and search.
      let selectorRows: { model_id: number; provider_id: number }[];
      if (!q.model?.trim() && !q.provider?.trim() && q.outcome === 'all') selectorRows = rows;
      else {
        const selectors = queryFilter(db, q, dims, true);
        selectorRows = db
          .query<{ model_id: number; provider_id: number }, (number | string)[]>(
            `SELECT DISTINCT e.model_id, e.provider_id FROM events e WHERE ${selectors.sql}`
          )
          .all(...selectors.args);
      }
      const selectorValues = (key: 'model_id' | 'provider_id') =>
        [...new Set(selectorRows.map((row) => names.get(row[key])!).filter(Boolean))].sort();
      const floor = Number(
        db
          .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'retention_floor_ms'")
          .get()?.value ?? 0
      );
      const gaps = db
        .query<{ instance: string; from_ms: number; to_ms: number }, [number, number]>(
          'SELECT instance, from_ms, to_ms FROM ingest_gaps WHERE from_ms < ? AND to_ms > ? ORDER BY from_ms, id'
        )
        .all(q.to_ms, q.from_ms);
      // Coverage describes the range, including rows hidden by filters or supplementary exclusion.
      const limitations = [...COVERAGE_LIMITATIONS];
      if (q.from_ms < floor)
        limitations.push(`History before retention_floor_ms ${floor} has been pruned.`);
      for (const gap of gaps)
        limitations.push(
          `Known collection gap for ${gap.instance}: [${gap.from_ms}, ${gap.to_ms}).`
        );
      if (coverageRows.some((row) => row.imported))
        limitations.push('History in this range was imported from CPAMP.');
      if (rates.error || !rates.book)
        limitations.push(
          'The rate book failed to load; the last good book is used when available.'
        );
      if (coverageRows.some((row) => !KNOWN_PROVIDERS.includes(names.get(row.provider_id)!)))
        limitations.push(
          'Records from an unknown provider are stored as reported; normalization is limited.'
        );
      limitations.push('records in flight during a collector or proxy restart may be absent');
      options.onPhase?.('coverage');
      const breakdown = (map: Map<number, Metrics>, ranked: typeof ranks.models) =>
        [...map]
          .map(([id, metrics]) => ({
            key: names.get(id)!,
            label: names.get(id) || 'Unknown',
            ...metrics.value,
            ...ranked.get(id),
          }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      check();
      return {
        schema_version: 1,
        generated_at_ms: (options.now ?? Date.now)(),
        from_ms: q.from_ms,
        to_ms: q.to_ms,
        granularity: q.granularity,
        coverage: {
          scope: 'retained-usage-events',
          raw_complete: q.from_ms >= floor && gaps.length === 0,
          limitations,
          source_attribution: sourceAttribution(page.items),
          price_basis: 'current-configured-rates',
          price_revision: rates.price_revision ?? '',
          timing_method: 'mixed-or-unknown',
        },
        summary: { ...summary.value, ...ranks.overall },
        timeline: [...timeline]
          .sort(([a], [b]) => a - b)
          .map(([bucket_ms, metrics]) => ({
            bucket_ms,
            ...metrics.value,
            ...ranks.buckets.get(bucket_ms),
          })),
        models: breakdown(models, ranks.models),
        providers: breakdown(providers, ranks.providers),
        filter_options: {
          models: selectorValues('model_id'),
          providers: selectorValues('provider_id'),
        },
        requests: { ...page, total_count: summary.value.calls },
        rates: buildRateInventory(q.catalog, [...observed.values()], book),
      };
    })
    .deferred();
}
