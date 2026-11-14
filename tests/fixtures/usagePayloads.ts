// Synthetic usage payloads shaped like CLIProxyAPI's internal/redisqueue plugin output
// (queuedUsageDetail, as asserted in plugin_test.go and measurement_test.go). No real data.

/** Distinct markers for every value that must never be stored. */
export const SECRET = {
  apiKey: 'SYNTHETIC-CLIENT-KEY-7f3a',
  source: 'SYNTHETIC-SOURCE-ACCOUNT@example.test',
  tokenHash: 'SYNTHETIC-ACCESS-TOKEN-HASH-91c2',
  /** A credential inside an upstream failure body; the text around it is stored, this is not. */
  failKey: 'sk-SYNTHETICFAILKEY0123456789abcdef',
  header:'SYNTHETIC-RESPONSE-HEADER-VALUE',
  query: 'SYNTHETIC-QUERY-CREDENTIAL',
  unknownField: 'SYNTHETIC-UNKNOWN-FIELD-VALUE',
} as const;

/** An upstream failure body. Its scrubbed text is the event's searchable failure summary. */
export const FAIL_BODY = 'SYNTHETIC-FAIL-BODY upstream said no';

type Payload = Record<string, unknown>;

/**
 * A complete Claude-style record. The legacy `tokens` counters deliberately differ from the
 * canonical `token_breakdown` (input 100 excludes cache; output 140 excludes reasoning), so a
 * test can tell which one a column was read from.
 */
export function usagePayload(overrides: Payload = {}): Payload {
  return {
    instance_id: 'claude-primary',
    usage_presence: 'reported',
    usage_fields: {
      input_tokens: true,
      output_tokens: true,
      reasoning_tokens: false,
      cache_read_tokens: true,
      cache_creation_tokens: true,
      total_tokens: true,
    },
    ttft_method: 'substantive-content',
    timing: {
      origin: 'execution-start',
      upstream_start_ms: 12,
      first_response_ms: 340,
      first_content_ms: 420,
      recorded_ms: 1500,
    },
    record_kind: 'execution',
    parent_execution_id: '',
    timestamp: '2026-04-25T00:00:00.123456789Z',
    latency_ms: 1500,
    ttft_ms: 420,
    source: SECRET.source,
    auth_index: '3',
    access_token_sha256: SECRET.tokenHash,
    client_ip: '192.0.2.10',
    resolved_client_ip: '203.0.113.5',
    x_forwarded_for: '203.0.113.5, 198.51.100.8',
    user_agent: 'test-client/1.0',
    tokens: {
      input_tokens: 100,
      output_tokens: 140,
      reasoning_tokens: 60,
      cached_tokens: 0,
      cache_read_tokens: 800,
      cache_read_tokens_present: true,
      cache_creation_tokens: 50,
      total_tokens: 1150,
    },
    failed: false,
    generate: true,
    stream: true,
    fail: { status_code: 200, body: '' },
    response_headers: { 'X-Upstream-Request-Id': [SECRET.header], 'Retry-After': ['30'] },
    accounting_version: 2,
    token_breakdown: {
      schema_version: 2,
      quality: 'complete',
      total_tokens: 1150,
      input: {
        total_tokens: 950,
        uncached_tokens: 100,
        cache_read_tokens: 800,
        cache_write_tokens: 50,
      },
      output: { total_tokens: 200, non_reasoning_tokens: 140, reasoning_tokens: 60 },
      unclassified_tokens: 0,
    },
    provider: 'claude',
    executor_type: 'ClaudeExecutor',
    model: 'claude-test-4',
    alias: 'client-claude',
    endpoint: 'POST /v1/messages',
    auth_type: 'oauth',
    api_key: SECRET.apiKey,
    is_native_key: false,
    request_id: '000000ab',
    execution_id: '12345678-1234-4234-8234-123456789abc',
    trace_id: '000000ab',
    session_id: '0f0e0d0c-0b0a-4908-8706-050403020100',
    parent_session_id: '',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    response_service_tier: 'standard',
    response_model: 'claude-test-4-20260401',
    ...overrides,
  };
}

/** The same record with another identity, for tests that need several events. */
export function usagePayloadNumber(index: number, overrides: Payload = {}): Payload {
  return usagePayload({
    execution_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    request_id: `req-${index}`,
    ...overrides,
  });
}
