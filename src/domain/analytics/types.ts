/** CPA owns calculations; Prox renders these versioned, safe query results. */
export interface AnalyticsQuery {
  from_ms: number;
  to_ms: number;
  time_zone: string;
  granularity: 'hour' | 'day';
  provider?: string;
  model?: string;
  outcome: 'all' | 'success' | 'failed';
  search?: string;
  limit?: number;
  before_ms?: number;
  before_id?: number;
}

export interface AnalyticsCost {
  usd: number | null;
  status: 'estimated' | 'partial' | 'unpriced' | 'explicit-zero' | 'unavailable';
  reasons: string[];
  priced_calls?: number;
  unpriced_calls?: number;
}

export interface AnalyticsTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  uncached_input_tokens: number | null;
}

export interface AnalyticsMetrics extends AnalyticsTokens {
  calls: number;
  success_calls: number;
  failure_calls: number;
  cost: AnalyticsCost;
  average_latency_ms: number | null;
  p95_latency_ms: number | null;
  p95_ttft_ms: number | null;
}

export interface AnalyticsTimelinePoint extends AnalyticsMetrics {
  bucket_ms: number;
}

export interface AnalyticsBreakdown extends AnalyticsMetrics {
  key: string;
  label: string;
}

/** A request's absent measurements are null; aggregate counters are known subtotals. */
export type AnalyticsRequestTokens = { [Field in keyof AnalyticsTokens]: number | null };

export interface AnalyticsRequest extends AnalyticsRequestTokens {
  usage_presence?: 'reported' | 'unknown';
  usage_fields?: {
    input_tokens: boolean;
    output_tokens: boolean;
    cache_read_tokens: boolean;
    cache_creation_tokens: boolean;
    reasoning_tokens: boolean;
    total_tokens: boolean;
  } | null;
  record_kind?: 'execution' | 'supplementary' | 'unknown';
  parent_execution_id?: string;
  timing?: {
    origin: 'execution-start';
    upstream_start_ms: number | null;
    first_response_ms: number | null;
    first_content_ms: number | null;
    recorded_ms: number | null;
  } | null;
  id: string;
  request_id?: string;
  execution_id?: string;
  instance_id?: string;
  timestamp_ms: number;
  provider: string;
  model: string;
  requested_model?: string;
  resolved_model?: string;
  response_model?: string;
  failed: boolean;
  status_code?: number;
  latency_ms: number | null;
  ttft_ms: number | null;
  output_tokens_per_second: number | null;
  timing_method: string;
  cost: AnalyticsCost;
  method?: string;
  path?: string;
  stream?: boolean;
  service_tier?: string;
  requested_service_tier?: string;
  effective_service_tier?: string;
  reasoning_effort?: string;
  executor_type?: string;
  session_id?: string;
  parent_session_id?: string;
  trace_id?: string;
  client_ip?: string;
  user_agent?: string;
  account_label?: string;
  error_summary?: string;
}

export interface RegisteredAnalyticsModel {
  instance_id: string;
  instance_label: string;
  provider: string;
  id: string;
}

export interface AnalyticsModelRate extends RegisteredAnalyticsModel {
  registered: boolean;
  matched_model: string | null;
  status: 'priced' | 'unpriced';
  input_per_million: number | null;
  output_per_million: number | null;
  cache_read_per_million: number | null;
  cache_write_per_million: number | null;
  source: string;
  updated_at_ms: number | null;
  context_tiers: Array<{
    above_input_tokens: number;
    input_per_million: number | null;
    output_per_million: number | null;
  }>;
  service_tiers: Array<{
    name: string;
    input_per_million: number | null;
    output_per_million: number | null;
  }>;
}

export interface AnalyticsResponse {
  schema_version: 1;
  generated_at_ms: number;
  from_ms: number;
  to_ms: number;
  granularity: 'hour' | 'day';
  coverage: {
    scope: 'retained-usage-events';
    raw_complete: boolean;
    limitations: string[];
    source_attribution: 'unavailable' | 'partial' | 'available';
    price_basis: 'current-configured-rates';
    price_revision: string;
    timing_method: string;
  };
  summary: AnalyticsMetrics;
  timeline: AnalyticsTimelinePoint[];
  models: AnalyticsBreakdown[];
  providers: AnalyticsBreakdown[];
  filter_options: { models: string[]; providers: string[] };
  requests: {
    items: AnalyticsRequest[];
    total_count: number;
    has_more: boolean;
    next_before_ms: number | null;
    next_before_id: number | null;
  };
  rates: AnalyticsModelRate[];
  catalog_sources?: Array<{ instance_id: string; label: string; state: 'ready' | 'unavailable' }>;
}
