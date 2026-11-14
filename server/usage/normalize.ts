// The one pure function from a proxy usage payload (CLIProxyAPI internal/redisqueue/plugin.go,
// queuedUsageDetail) to a row. No I/O and no SQLite. Rules: server/usage/RULES.md.
import { createHash } from 'node:crypto';
import { sanitizeCredentialText } from './credentialText';
import {
  RECORD_KIND,
  TIMING_METHODS,
  USAGE_FLAG,
  type AccountLabelLookup,
  type EventSession,
  type EventTiming,
  type EventTokens,
  type NormalizeResult,
  type RecordKindCode,
  type SanitizedPayload,
  type TimingMethod,
} from './types';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const orNull = (value: string): string | null => (value === '' ? null : value);
/** A token or offset the proxy can report: a non-negative integer. */
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** The proxy's `timestamp` (Go time.Time, RFC 3339 with up to nanoseconds) in milliseconds,
 * truncated like Go's UnixMilli. JavaScript's own parser is not specified beyond three digits. */
function timestampMs(value: unknown): number | null {
  const match = typeof value === 'string' ? RFC3339.exec(value.trim()) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const local = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  // Date.UTC rolls an impossible field over (month 13, second 60) instead of failing.
  if (
    new Date(local).toISOString().slice(0, 19) !==
    `${year}-${month}-${day}T${hour}:${minute}:${second}`
  ) {
    return null;
  }
  const offsetMinutes =
    zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (+zone.slice(1, 3) * 60 + +zone.slice(4, 6));
  return local - offsetMinutes * 60_000 + Number(fraction.slice(0, 3).padEnd(3, '0'));
}

const REASONING_SUFFIXES = new Set([
  'none',
  'auto',
  '-1',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const MAX_INT64 = BigInt('9223372036854775807');

/** Drop a trailing reasoning suffix such as "(high)" or "(8192)"; any other suffix stays. */
export function analyticsModel(model: string): string {
  const open = model.lastIndexOf('(');
  if (open <= 0 || !model.endsWith(')')) return model;
  const suffix = model.slice(open + 1, -1);
  const isBudget = /^[+-]?\d+$/.test(suffix) && BigInt(suffix) >= 0 && BigInt(suffix) <= MAX_INT64;
  return REASONING_SUFFIXES.has(suffix.toLowerCase()) || isBudget ? model.slice(0, open) : model;
}

/** Codex answers default/auto even when a faster tier was requested, so its request wins. */
function pricingTier(identity: string, requested: string, response: string): string {
  return identity.toLowerCase().includes('codex') ? requested || response : response || requested;
}

function canonicalTokens(record: Json): EventTokens | null {
  const breakdown = record.token_breakdown;
  if (record.accounting_version !== 2 || !isObject(breakdown) || breakdown.schema_version !== 2) {
    return null;
  }
  const { input, output, quality } = breakdown;
  if (typeof quality !== 'string' || quality.trim() !== 'complete') return null;
  if (!isObject(input) || !isObject(output)) return null;
  const values = [
    breakdown.unclassified_tokens,
    breakdown.total_tokens,
    input.total_tokens,
    input.uncached_tokens,
    input.cache_read_tokens,
    input.cache_write_tokens,
    output.total_tokens,
    output.non_reasoning_tokens,
    output.reasoning_tokens,
  ].map(count);
  if (values.includes(undefined)) return null;
  const [
    unclassified,
    total,
    inputTotal,
    inputUncached,
    cacheRead,
    cacheWrite,
    outputTotal,
    nonReasoning,
    reasoning,
  ] = values as number[];
  if (
    unclassified !== 0 ||
    inputTotal !== inputUncached + cacheRead + cacheWrite ||
    outputTotal !== nonReasoning + reasoning ||
    total !== inputTotal + outputTotal
  ) {
    return null;
  }
  return { inputTotal, inputUncached, cacheRead, cacheWrite, outputTotal, reasoning, total };
}

/** The proxy's counters as reported. Nothing is inferred about how input relates to cache. */
function rawCounterTokens(record: Json): EventTokens {
  const tokens = isObject(record.tokens) ? record.tokens : {};
  const input = count(tokens.input_tokens) ?? 0;
  return {
    inputTotal: input,
    inputUncached: input,
    cacheRead: count(tokens.cache_read_tokens) ?? 0,
    cacheWrite: count(tokens.cache_creation_tokens) ?? 0,
    outputTotal: count(tokens.output_tokens) ?? 0,
    reasoning: count(tokens.reasoning_tokens) ?? 0,
    total: count(tokens.total_tokens) ?? 0,
  };
}

const FIELD_FLAGS: ReadonlyArray<readonly [string, number]> = [
  ['input_tokens', USAGE_FLAG.inputTokens],
  ['output_tokens', USAGE_FLAG.outputTokens],
  ['reasoning_tokens', USAGE_FLAG.reasoningTokens],
  ['cache_read_tokens', USAGE_FLAG.cacheReadTokens],
  ['cache_creation_tokens', USAGE_FLAG.cacheCreationTokens],
  ['total_tokens', USAGE_FLAG.totalTokens],
];

function presenceFlags(record: Json): number {
  let flags = text(record.usage_presence) === 'reported' ? USAGE_FLAG.presenceReported : 0;
  const fields = record.usage_fields;
  // One non-boolean member invalidates the whole object, as it does for the proxy's own reader.
  if (
    isObject(fields) &&
    FIELD_FLAGS.every(([key]) => fields[key] == null || typeof fields[key] === 'boolean')
  ) {
    flags |= USAGE_FLAG.fieldsPresent;
    for (const [key, flag] of FIELD_FLAGS) if (fields[key] === true) flags |= flag;
  }
  return flags;
}

const MAX_TIMING_OFFSET_MS = 31 * 24 * 60 * 60 * 1000;

function eventTiming(value: unknown): EventTiming | null {
  if (!isObject(value) || value.origin !== 'execution-start') return null;
  const offsets = [
    value.upstream_start_ms,
    value.first_response_ms,
    value.first_content_ms,
    value.recorded_ms,
  ].map((offset) => (offset == null ? null : (count(offset) ?? NaN)));
  const [upstreamStartMs, firstResponseMs, firstContentMs, recordedMs] = offsets;
  const inRange = offsets.every(
    (offset) =>
      offset === null ||
      (offset <= MAX_TIMING_OFFSET_MS && (recordedMs === null || offset <= recordedMs))
  );
  const ordered =
    (upstreamStartMs === null || firstResponseMs === null || firstResponseMs >= upstreamStartMs) &&
    (firstResponseMs === null || firstContentMs === null || firstContentMs >= firstResponseMs);
  return inRange && ordered
    ? { upstreamStartMs, firstResponseMs, firstContentMs, recordedMs }
    : null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let kept = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes - 3) break;
    kept += character;
    bytes += size;
  }
  return `${kept.trim()}...`;
}

/** Client-supplied request metadata: one line of printable text, bounded. */
function requestMetadata(value: unknown, maxBytes: number): string | null {
  const cleaned = text(value)
    .replace(/[\s\p{C}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  return orNull(truncateUtf8(cleaned, maxBytes));
}

/** CPAMP's cap on the failure text (usage/event.go maxFailSummaryBytes). The only knob on how much
 * upstream error text is kept: lowering it makes imported and live values differ from CPAMP's. */
export const FAIL_SUMMARY_MAX_BYTES = 4096;
const HEADER_VALUE_MAX_BYTES = 1024;
const EMAIL_ADDRESS = /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * CPAMP's FailSummaryFromBody: the credential scrubber, e-mail addresses masked to their first
 * character, then capped. It is the only way failure text enters the store, for live events and
 * for CPAMP's persisted value alike; scrubbing a scrubbed value changes nothing.
 */
export function failSummaryFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const scrubbed = sanitizeCredentialText(trimmed).replace(EMAIL_ADDRESS, '$1***$3');
  return orNull(truncateUtf8(scrubbed.trim(), FAIL_SUMMARY_MAX_BYTES));
}

// CPAMP's trace headers (usage/response_headers.go parseTraceHeaders), in its priority order.
const TRACE_HEADERS = [
  'x-oai-request-id',
  'x-request-id',
  'x-oneapi-request-id',
  'x-cloudaicompanion-trace-id',
  'cf-ray',
  'eagleid',
  'x-client-request-id',
  'x-zeabur-request-id',
] as const;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

const headerValue = (value: string): string => {
  const trimmed = value.trim();
  return trimmed ? truncateUtf8(failSummaryFromBody(trimmed) ?? '', HEADER_VALUE_MAX_BYTES) : '';
};

/**
 * The event's `header_trace_id`, derived like CPAMP's PrimaryTraceID: the first present trace
 * header in a fixed order, else the trace-id of a valid W3C traceparent. Only those nine header
 * names are read; no other response header is kept.
 */
export function headerTraceId(headers: unknown): string | null {
  if (!isObject(headers)) return null;
  const byName = new Map<string, string[]>();
  for (const key of Object.keys(headers).sort()) {
    const name = key.trim().toLowerCase();
    const value = headers[key];
    const values = (Array.isArray(value) ? value : [value])
      .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
      .map((item) => String(item).trim())
      .filter(Boolean);
    if (values.length) byName.set(name, [...(byName.get(name) ?? []), ...values]);
  }
  const first = (name: string) => headerValue(byName.get(name)?.[0] ?? '');
  const parts = TRACEPARENT.exec(first('traceparent').toLowerCase());
  const traceparentId =
    parts && !first('traceparent').toLowerCase().startsWith('ff-') && !/^0+$/.test(parts[1]) && !/^0+$/.test(parts[2])
      ? parts[1]
      : '';
  const primary = [...TRACE_HEADERS.map(first), traceparentId].find((value) => value !== '') ?? '';
  return orNull(sanitizeCredentialText(primary).trim());
}

const UUID_VERSION =/^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The proxy projects every id it derives itself to a version 8 UUID (session/identity.go). */
function eventSession(value: unknown): EventSession | null {
  const uuid = text(value);
  return uuid ? { uuid, derived: UUID_VERSION.exec(uuid)?.[1] === '8' } : null;
}

const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)/;
/** Query strings can carry client credentials, so they are never kept. */
const withoutQuery = (value: string): string => value.split('?')[0];

// The raw buffer keeps only what an event could be re-derived from. `true` keeps a scalar,
// `false` names a field the proxy is known to send that is deliberately not kept (secrets,
// and detail no event column reads), an object describes a nested allowlist. A key that is
// not named here is new to this normalizer: it is dropped and counted.
type Allowlist = { readonly [key: string]: boolean | Allowlist };
const RAW_ALLOWLIST: Allowlist = {
  api_key: false,
  source: false,
  access_token_sha256: false,
  response_headers: false,
  home_selection: false,
  cache_details: false,
  web_search_requests: false,
  image_count: false,
  requested_image_details: false,
  image_details: false,
  media_counts: false,
  tool_usage_details: false,
  iterations: false,
  cost_details: false,
  fail: { status_code: true, code: true, body: false },
  usage_fields: {
    input_tokens: true,
    output_tokens: true,
    reasoning_tokens: true,
    cache_read_tokens: true,
    cache_creation_tokens: true,
    total_tokens: true,
  },
  timing: {
    origin: true,
    upstream_start_ms: true,
    first_response_ms: true,
    first_content_ms: true,
    recorded_ms: true,
  },
  tokens: {
    input_tokens: true,
    output_tokens: true,
    reasoning_tokens: true,
    cached_tokens: true,
    cache_read_tokens: true,
    cache_read_tokens_present: true,
    cache_creation_tokens: true,
    cache_creation_5m_tokens: true,
    cache_creation_30m_tokens: true,
    cache_creation_1h_tokens: true,
    cache_creation_12h_tokens: true,
    text_input_tokens: true,
    image_input_tokens: true,
    audio_input_tokens: true,
    video_input_tokens: true,
    file_input_tokens: true,
    cached_text_tokens: true,
    cached_image_tokens: true,
    cached_audio_tokens: true,
    text_output_tokens: true,
    image_output_tokens: true,
    audio_output_tokens: true,
    accepted_prediction_tokens: true,
    rejected_prediction_tokens: true,
    total_tokens: true,
  },
  token_breakdown: {
    schema_version: true,
    quality: true,
    total_tokens: true,
    unclassified_tokens: true,
    input: {
      total_tokens: true,
      uncached_tokens: true,
      cache_read_tokens: true,
      cache_write_tokens: true,
    },
    output: { total_tokens: true, non_reasoning_tokens: true, reasoning_tokens: true },
  },
  instance_id: true,
  usage_presence: true,
  ttft_method: true,
  record_kind: true,
  parent_execution_id: true,
  timestamp: true,
  latency_ms: true,
  ttft_ms: true,
  auth_index: true,
  client_ip: true,
  resolved_client_ip: true,
  x_forwarded_for: true,
  user_agent: true,
  failed: true,
  generate: true,
  stream: true,
  accounting_version: true,
  provider: true,
  executor_type: true,
  model: true,
  alias: true,
  endpoint: true,
  auth_type: true,
  is_native_key: true,
  access_provider: true,
  request_id: true,
  execution_id: true,
  trace_id: true,
  session_id: true,
  parent_session_id: true,
  node_kind: true,
  is_fork: true,
  is_compaction: true,
  reasoning_effort: true,
  service_tier: true,
  effective_service_tier: true,
  response_service_tier: true,
  upstream_service_tier: true,
  response_model: true,
  speed: true,
  inference_geo: true,
};

function allowlisted(source: Json, allowlist: Allowlist, dropped: { count: number }): Json {
  const kept: Json = {};
  for (const [key, value] of Object.entries(source)) {
    // An own-property check: a payload key such as "constructor" must not find Object's.
    const rule = Object.prototype.hasOwnProperty.call(allowlist, key) ? allowlist[key] : undefined;
    if (rule === false) continue;
    if (rule === true && (value === null || typeof value !== 'object')) kept[key] = value;
    else if (typeof rule === 'object' && isObject(value)) {
      kept[key] = allowlisted(value, rule, dropped);
    } else if (typeof rule === 'object' && value === null) kept[key] = null;
    else dropped.count += 1;
  }
  return kept;
}

function sanitizePayload(record: Json): SanitizedPayload {
  const dropped = { count: 0 };
  const kept = allowlisted(record, RAW_ALLOWLIST, dropped);
  if (typeof kept.endpoint === 'string') kept.endpoint = withoutQuery(kept.endpoint);
  return { json: JSON.stringify(kept), droppedKeys: dropped.count };
}

/** The proxy's two control messages are objects with exactly one key whose value is true. */
function controlPayload(record: Json): 'refresh' | 'support-refresh' | null {
  const keys = Object.keys(record);
  if (keys.length !== 1 || record[keys[0]] !== true) return null;
  if (keys[0] === 'refresh') return 'refresh';
  return keys[0] === 'support_refresh' ? 'support-refresh' : null;
}

/**
 * Normalize one usage payload. `labelFor` supplies the credential label in force now; without
 * it (or for an unknown auth index) the account is the proxy's auth index and has no label.
 */
export function normalizeUsagePayload(
  payload: string,
  labelFor?: AccountLabelLookup
): NormalizeResult {
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch {
    return { kind: 'rejected', reason: 'not-json', raw: null };
  }
  if (!isObject(record)) return { kind: 'rejected', reason: 'not-an-object', raw: null };
  const control = controlPayload(record);
  if (control) return { kind: 'control', control };

  const raw = sanitizePayload(record);
  const executionId = text(record.execution_id);
  if (!executionId) return { kind: 'rejected', reason: 'missing-execution-id', raw };
  const tsMs = timestampMs(record.timestamp);
  if (tsMs === null) return { kind: 'rejected', reason: 'invalid-timestamp', raw };

  const provider = text(record.provider) || 'unknown';
  const executor = text(record.executor_type);
  const resolvedModel = text(record.model);
  const requestedModel = text(record.alias) || resolvedModel || '-';
  const model = analyticsModel(requestedModel);

  const requestedTier = text(record.service_tier);
  const effectiveTier = text(record.effective_service_tier);
  const tier = pricingTier(
    [executor, provider, text(record.auth_type)].join(' '),
    effectiveTier || requestedTier,
    text(record.response_service_tier)
  );

  const reportedMethod = text(record.ttft_method);
  const timingMethod: TimingMethod = (TIMING_METHODS as readonly string[]).includes(reportedMethod)
    ? (reportedMethod as TimingMethod)
    : 'unknown';
  const latency = count(record.latency_ms);
  const ttft = count(record.ttft_ms);
  const ttftReported =
    ttft !== undefined &&
    timingMethod !== 'unavailable' &&
    // A zero from an unknown method is "not measured", never an instant first token.
    (ttft > 0 || timingMethod !== 'unknown');

  const canonical = canonicalTokens(record);
  const usageFlags = presenceFlags(record) | (canonical ? USAGE_FLAG.breakdownComplete : 0);
  const recordKind: RecordKindCode =
    record.record_kind === 'execution'
      ? RECORD_KIND.execution
      : record.record_kind === 'supplementary'
        ? RECORD_KIND.supplementary
        : RECORD_KIND.unknown;

  const authIndex = text(record.auth_index);
  const session = eventSession(record.session_id);
  const parentSession = session ? eventSession(record.parent_session_id) : null;
  const label = authIndex && labelFor ? labelFor(authIndex) : undefined;
  const apiKey = text(record.api_key);
  const endpoint = ENDPOINT.exec(text(record.endpoint));
  const fail = isObject(record.fail) ? record.fail : {};

  return {
    kind: 'event',
    raw,
    event: {
      executionId,
      tsMs,
      instance: orNull(text(record.instance_id)),
      provider,
      model,
      requestedModel,
      billingModel: resolvedModel || model,
      responseModel: orNull(text(record.response_model)),
      tier,
      requestedTier: orNull(requestedTier),
      effectiveTier: orNull(effectiveTier),
      failed: record.failed === true,
      statusCode: count(fail.status_code) || null,
      latencyMs: latency || null,
      ttftMs: ttftReported ? ttft : null,
      timingMethod,
      tokens: canonical ?? rawCounterTokens(record),
      usageFlags,
      recordKind,
      stream: typeof record.stream === 'boolean' ? record.stream : null,
      authIndex: orNull(authIndex),
      account: orNull(label?.account ?? '') ?? orNull(authIndex),
      accountLabel: orNull(label?.label ?? ''),
      apiKeyHash: apiKey ? createHash('sha256').update(apiKey).digest('hex') : null,
      userAgent: requestMetadata(record.user_agent, 1024),
      clientIp: requestMetadata(record.client_ip, 64),
      path: endpoint ? orNull(withoutQuery(endpoint[2])) : null,
      method: endpoint ? endpoint[1] : null,
      effort: orNull(text(record.reasoning_effort)),
      executor: orNull(executor),
      requestId: orNull(text(record.request_id)),
      parentExecutionId: orNull(text(record.parent_execution_id)),
      session,
      parentSession: parentSession?.uuid === session?.uuid ? null : parentSession,
      traceId: orNull(text(record.trace_id)),
      timing: eventTiming(record.timing),
      failSummary: failSummaryFromBody(text(fail.body)),
      headerTraceId: headerTraceId(record.response_headers),
      authFile: orNull(text(label?.file)),
    },
  };
}
