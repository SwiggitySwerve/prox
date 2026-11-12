// Writer-owned, ephemeral lifetime fold. HTTP and the Python shim only transport these results.
import type { EventTokens, NormalizedEvent } from './types';
import { RATE_FIELDS, type RateBook } from './rates';
import { contextBand, exporterRates, tokenCostUsd } from './pricing';

export type ExporterEvent = Pick<
  NormalizedEvent,
  | 'provider'
  | 'requestedModel'
  | 'billingModel'
  | 'account'
  | 'apiKeyHash'
  | 'failed'
  | 'tsMs'
  | 'latencyMs'
  | 'ttftMs'
  | 'tier'
  | 'tokens'
  | 'reportedInputTokens'
  | 'reportedCachedTokens'
  | 'reportedOutputTokens'
  | 'reportedReasoningTokens'
  | 'reportedTotalTokens'
  | 'reportedLatencyMs'
  | 'reportedTtftMs'
>;
export interface ExporterGroup {
  provider: string;
  model: string;
  account: string | null;
  client: string;
  status: 'success' | 'failed';
  requests: number;
  tokens: { input: number; output: number; cached: number; reasoning: number };
  cache: { read: number; write: number };
  latency_seconds_sum: number;
  latency_seconds_count: number;
  ttft_seconds_sum: number;
  ttft_seconds_count: number;
  zero_token_success: number;
  cost_usd: number | null;
}
export interface ExporterSnapshot {
  schema_version: 1;
  groups: ExporterGroup[];
  newest_event_time_seconds: number;
  models_priced: number;
  missing_reported_counters: number;
}
interface FoldGroup {
  provider: string;
  model: string;
  billingModel: string;
  account: string | null;
  keyHash: string | null;
  failed: boolean;
  tier: string;
  band: number | null;
  calls: number;
  input: number;
  cached: number;
  tokens: EventTokens;
  latency: number;
  ttft: number;
  ttftCount: number;
  zero: number;
}
const zeroTokens = (): EventTokens => ({
  inputTotal: 0,
  inputUncached: 0,
  cacheRead: 0,
  cacheWrite: 0,
  outputTotal: 0,
  reasoning: 0,
  total: 0,
});

/** Only thresholds affect grouping. Ordinary price changes reprice the existing groups. */
export function exporterThresholds(book: RateBook | null): string {
  return JSON.stringify(
    Object.entries(book?.models ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, model]) => model.context_tiers.length)
      .map(([name, model]) => [name, model.context_tiers.map((row) => row.above_input_tokens)])
  );
}
export class UsageExporter {
  private groups = new Map<string, FoldGroup>();
  private book: RateBook | null = null;
  private newest = 0;
  private missing = 0;
  private thresholds: string | null = null;
  private dirty = true;

  constructor(private readonly scan: (visit: (event: ExporterEvent) => void) => void) {}

  invalidate(): void {
    this.dirty = true;
  }

  refresh(book: RateBook | null): void {
    const thresholds = exporterThresholds(book);
    this.book = book;
    if (!this.dirty && thresholds === this.thresholds) return;
    // Publish a fold only after a complete successful scan.
    const next = new UsageExporter(this.scan);
    next.book = book;
    this.scan((event) => next.add(event));
    this.groups = next.groups;
    this.newest = next.newest;
    this.missing = next.missing;
    this.thresholds = thresholds;
    this.dirty = false;
  }

  add(event: ExporterEvent): void {
    const { tokens } = event;
    // Match the old SQL: largest exceeded threshold across billing and requested model.
    let band: number | null = null;
    for (const name of [event.billingModel, event.requestedModel]) {
      const model = this.book?.models[name];
      const candidate = model ? contextBand(model, tokens.inputTotal) : null;
      if (candidate !== null) band = Math.max(band ?? 0, candidate);
    }
    const key = JSON.stringify([
      event.provider,
      event.requestedModel,
      event.billingModel,
      event.account,
      event.apiKeyHash,
      event.failed,
      event.tier,
      band,
    ]);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        provider: event.provider,
        model: event.requestedModel,
        billingModel: event.billingModel,
        account: event.account,
        keyHash: event.apiKeyHash,
        failed: event.failed,
        tier: event.tier,
        band,
        calls: 0,
        input: 0,
        cached: 0,
        tokens: zeroTokens(),
        latency: 0,
        ttft: 0,
        ttftCount: 0,
        zero: 0,
      };
      this.groups.set(key, group);
    }
    if (
      event.reportedInputTokens == null ||
      event.reportedCachedTokens == null ||
      event.reportedOutputTokens == null ||
      event.reportedReasoningTokens == null ||
      event.reportedTotalTokens == null
    )
      this.missing += 1;
    group.calls += 1;
    group.input += event.reportedInputTokens ?? 0;
    group.cached += event.reportedCachedTokens ?? 0;
    const sourceTokens = {
      ...tokens,
      outputTotal: event.reportedOutputTokens ?? 0,
      reasoning: event.reportedReasoningTokens ?? 0,
    };
    for (const name of Object.keys(sourceTokens) as (keyof EventTokens)[])
      group.tokens[name] += sourceTokens[name];
    group.latency += event.reportedLatencyMs ?? 0;
    if (event.reportedTtftMs != null && event.reportedTtftMs > 0) {
      group.ttft += event.reportedTtftMs;
      group.ttftCount += 1;
    }
    if (!event.failed && event.reportedTotalTokens === 0) group.zero += 1;
    this.newest = Math.max(this.newest, event.tsMs);
  }

  snapshot(aliases: ReadonlyMap<string, string>): ExporterSnapshot {
    const groups = new Map<string, ExporterGroup>();
    for (const row of this.groups.values()) {
      const client =
        aliases.get(row.keyHash ?? '') ||
        (row.keyHash ? `key ${row.keyHash.slice(0, 8)}` : 'unknown');
      const status = row.failed ? ('failed' as const) : ('success' as const);
      const key = JSON.stringify([row.provider, row.model, row.account, client, status]);
      let group = groups.get(key);
      if (!group) {
        group = {
          provider: row.provider,
          model: row.model,
          account: row.account,
          client,
          status,
          requests: 0,
          tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
          cache: { read: 0, write: 0 },
          latency_seconds_sum: 0,
          latency_seconds_count: 0,
          ttft_seconds_sum: 0,
          ttft_seconds_count: 0,
          zero_token_success: 0,
          cost_usd: null,
        };
        groups.set(key, group);
      }
      group.requests += row.calls;
      group.tokens.input += row.input;
      group.tokens.output += row.tokens.outputTotal;
      group.tokens.cached += row.cached;
      group.tokens.reasoning += row.tokens.reasoning;
      group.cache.read += row.tokens.cacheRead;
      group.cache.write += row.tokens.cacheWrite;
      group.latency_seconds_sum += row.latency / 1000;
      // Old exporter counts ALL calls for latency, including absent/zero measurements.
      group.latency_seconds_count += row.calls;
      group.ttft_seconds_sum += row.ttft / 1000;
      group.ttft_seconds_count += row.ttftCount;
      group.zero_token_success += row.zero;
      const rates =
        this.book && exporterRates(this.book, row.billingModel, row.model, row.tier, row.band);
      if (rates) group.cost_usd = (group.cost_usd ?? 0) + tokenCostUsd(row.tokens, rates);
    }
    return {
      schema_version: 1,
      groups: [...groups.values()],
      newest_event_time_seconds: this.newest / 1000,
      models_priced: Object.values(this.book?.models ?? {}).filter((model) =>
        RATE_FIELDS.some((field) => model[field] !== null)
      ).length,
      missing_reported_counters: this.missing,
    };
  }
}
