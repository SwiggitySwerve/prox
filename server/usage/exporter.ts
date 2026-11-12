// Writer-owned, ephemeral lifetime fold. HTTP and the Python shim only transport these results.
import { RECORD_KIND, type EventTokens, type NormalizedEvent } from './types';
import type { RateBook } from './rates';
import {
  buildRateInventory,
  contextBand,
  estimateAggregateCost,
  resolveModelPrice,
} from './pricing';

export type ExporterEvent = Pick<
  NormalizedEvent,
  | 'provider'
  | 'model'
  | 'recordKind'
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
}
interface FoldGroup {
  provider: string;
  model: string;
  billingModel: string;
  requestedModel: string;
  account: string | null;
  keyHash: string | null;
  failed: boolean;
  tier: string;
  band: number | null;
  calls: number;
  tokens: EventTokens;
  latency: number;
  latencyCount: number;
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

/** Bands use analytics' first matching pricing candidate. Membership and thresholds affect grouping. */
export function exporterThresholds(book: RateBook | null): string {
  return JSON.stringify(
    Object.entries(book?.models ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, model]) => [name, model.context_tiers.map((row) => row.above_input_tokens)])
  );
}
export class UsageExporter {
  private groups = new Map<string, FoldGroup>();
  private book: RateBook | null = null;
  private newest = 0;
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
    this.thresholds = thresholds;
    this.dirty = false;
  }

  add(event: ExporterEvent): void {
    if (event.recordKind === RECORD_KIND.supplementary) return;
    const { tokens } = event;
    const price =
      this.book &&
      resolveModelPrice([event.billingModel, event.model, event.requestedModel], this.book);
    const band = price ? contextBand(price.price, tokens.inputTotal) : null;
    const key = JSON.stringify([
      event.provider,
      event.model,
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
        model: event.model,
        requestedModel: event.requestedModel,
        billingModel: event.billingModel,
        account: event.account,
        keyHash: event.apiKeyHash,
        failed: event.failed,
        tier: event.tier,
        band,
        calls: 0,
        tokens: zeroTokens(),
        latency: 0,
        latencyCount: 0,
        ttft: 0,
        ttftCount: 0,
        zero: 0,
      };
      this.groups.set(key, group);
    }
    group.calls += 1;
    for (const name of Object.keys(tokens) as (keyof EventTokens)[])
      group.tokens[name] += tokens[name];
    if (event.latencyMs !== null) {
      group.latency += event.latencyMs;
      group.latencyCount += 1;
    }
    if (event.ttftMs !== null && event.ttftMs > 0) {
      group.ttft += event.ttftMs;
      group.ttftCount += 1;
    }
    if (!event.failed && tokens.total === 0) group.zero += 1;
    this.newest = Math.max(this.newest, event.tsMs);
  }

  snapshot(aliases: ReadonlyMap<string, string>): ExporterSnapshot {
    const groups = new Map<string, ExporterGroup>();
    for (const row of this.groups.values()) {
      const client =
        aliases.get(row.keyHash ?? '') ||
        (row.keyHash ? `key ${row.keyHash.slice(0, 8)}` : 'unknown');
      const status = row.failed ? ('failed' as const) : ('success' as const);
      const key = JSON.stringify([row.provider, row.requestedModel, row.account, client, status]);
      let group = groups.get(key);
      if (!group) {
        group = {
          provider: row.provider,
          model: row.requestedModel,
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
      group.tokens.input += row.tokens.inputTotal;
      group.tokens.output += row.tokens.outputTotal;
      group.tokens.cached += row.tokens.cacheRead;
      group.tokens.reasoning += row.tokens.reasoning;
      group.cache.read += row.tokens.cacheRead;
      group.cache.write += row.tokens.cacheWrite;
      group.latency_seconds_sum += row.latency / 1000;
      group.latency_seconds_count += row.latencyCount;
      group.ttft_seconds_sum += row.ttft / 1000;
      group.ttft_seconds_count += row.ttftCount;
      group.zero_token_success += row.zero;
      const cost =
        this.book &&
        estimateAggregateCost(
          {
            ...row,
            contextThreshold: row.band,
            usageFlags: 0,
            recordKind: RECORD_KIND.execution,
          },
          this.book
        );
      if (cost && cost.usd !== null) group.cost_usd = (group.cost_usd ?? 0) + cost.usd;
    }
    return {
      schema_version: 1,
      groups: [...groups.values()],
      newest_event_time_seconds: this.newest / 1000,
      models_priced: this.book
        ? buildRateInventory(
            [],
            Object.keys(this.book.models).map((id) => ({ provider: '', id })),
            this.book
          ).filter((rate) => rate.status === 'priced').length
        : 0,
    };
  }
}
