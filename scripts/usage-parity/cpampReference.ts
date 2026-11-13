// Independent CPAMP oracle, not a call back into the Prox normalizer being audited.
// Contract: CPAMP usageevent/aggregate.go, usageidentity/model.go and usage/analytics.go.
import {
  CPAMP_EVENT_COLUMNS,
  CPAMP_METADATA_KEYS,
  type CpampSourceRow,
  type Preconditions,
} from '../../server/usage/importCpamp';
import { sanitizeCredentialText } from '../../server/usage/credentialText';
import { RECORD_KIND, USAGE_FLAG } from '../../server/usage/types';

export const CPAMP_PARITY_COLUMNS = `${CPAMP_EVENT_COLUMNS}, service_tier`;
export type CpampTimingMethod =
  'unknown' | 'unavailable' | 'first-byte' | 'substantive-content' | 'fallback-packet';
export interface CpampEventReference extends EventValues {
  ttft_method: CpampTimingMethod;
}
// CPAMP AnalyticsMetadataFromJSON recognizes only these exact sanitized strings.
function timingMethod(value: unknown): CpampTimingMethod {
  const method = identifier(value);
  return method === 'unavailable' ||
    method === 'first-byte' ||
    method === 'substantive-content' ||
    method === 'fallback-packet'
    ? method
    : 'unknown';
}
export interface EventValues {
  execution_id: string;
  instance: string | null;
  ts_ms: number;
  provider: string | null;
  account: string | null;
  account_label: string | null;
  api_key_hash: string | null;
  model: string;
  requested_model: string;
  billing_model: string;
  tier: string;
  failed: number;
  status_code: number | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  input_total: number;
  input_uncached: number;
  cache_read: number;
  cache_write: number;
  output_total: number;
  reasoning: number;
  total: number;
  usage_flags: number;
  record_kind: number;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const nullable = (value: unknown) => (typeof value === 'string' ? value : null);
// Go strings.TrimSpace uses Unicode White_Space: it includes NEL and excludes BOM.
function goTrim(value: string): string {
  const space = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
  const chars = [...value];
  let first = 0,
    end = chars.length;
  while (first < end && space.test(chars[first])) first++;
  while (end > first && space.test(chars[end - 1])) end--;
  return chars.slice(first, end).join('');
}

// CPAMP's AnalyticsMetadataFromJSON.safe trims/scrubs and truncates identifiers at 256 UTF-8 bytes.
function identifier(value: unknown): string {
  const safe = sanitizeCredentialText(goTrim(string(value)));
  let result = '';
  for (const char of safe) {
    if (Buffer.byteLength(result + char) > 256) break;
    result += char;
  }
  return result;
}
// Independent port of CPAMP AnalyticsModel. Only persisted request/model columns feed it.
function cpampModel(value: string): string {
  if (!value.endsWith(')')) return value;
  const match = /\((none|auto|-1|minimal|low|medium|high|xhigh|max|[+-]?\d+)\)$/i.exec(value);
  if (!match || match.index === 0) return value;
  const suffix = match[1];
  if (
    /^[+-]?\d+$/.test(suffix) &&
    suffix !== '-1' &&
    (BigInt(suffix) < 0n || BigInt(suffix) > 9223372036854775807n)
  )
    return value;
  return value.slice(0, match.index);
}
const counters = [
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'output_total',
  'reasoning',
  'total',
] as const;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const USAGE_FIELD_BITS = {
  input_tokens: USAGE_FLAG.inputTokens,
  output_tokens: USAGE_FLAG.outputTokens,
  reasoning_tokens: USAGE_FLAG.reasoningTokens,
  cache_read_tokens: USAGE_FLAG.cacheReadTokens,
  cache_creation_tokens: USAGE_FLAG.cacheCreationTokens,
  total_tokens: USAGE_FLAG.totalTokens,
};

type MetadataShape = {
  readonly [key: string]: 'string' | 'boolean' | 'integer' | 'nullable-integer' | MetadataShape;
};
const METADATA_SHAPE: MetadataShape = {
  ...Object.fromEntries(CPAMP_METADATA_KEYS.map((key) => [key, 'string' as const])),
  accounting_version: 'integer',
  usage_fields: Object.fromEntries(
    Object.keys(USAGE_FIELD_BITS).map((key) => [key, 'boolean' as const])
  ),
  token_breakdown: {
    schema_version: 'integer',
    quality: 'string',
    total_tokens: 'integer',
    unclassified_tokens: 'integer',
    input: {
      total_tokens: 'integer',
      uncached_tokens: 'integer',
      cache_read_tokens: 'integer',
      cache_write_tokens: 'integer',
    },
    output: {
      total_tokens: 'integer',
      non_reasoning_tokens: 'integer',
      reasoning_tokens: 'integer',
    },
  },
  timing: {
    origin: 'string',
    upstream_start_ms: 'nullable-integer',
    first_response_ms: 'nullable-integer',
    first_content_ms: 'nullable-integer',
    recorded_ms: 'nullable-integer',
  },
};
// Go's struct decoder folds field names; the oracle supports only canonical encodings.
// Reject aliases instead of trying to reproduce Go's matching/assignment precedence.
function canonicalMetadata(value: unknown, shape: MetadataShape, optionalValues = false): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(shape, key)) {
      // The fixed ASCII field names contain no regexp metacharacters. Unicode case folding
      // also catches aliases such as input_tokenſ, which Go matches to input_tokens.
      if (Object.keys(shape).some((known) => new RegExp(`^${known}$`, 'iu').test(key)))
        return false;
      continue; // Unrelated extensions are ignored by both decoders.
    }
    const rule = shape[key];
    if (child === null && (optionalValues || rule === 'nullable-integer')) continue;
    if (typeof rule === 'object') {
      if (!canonicalMetadata(child, rule)) return false;
    } else if (rule === 'integer' || rule === 'nullable-integer') {
      if (typeof child !== 'number' || !Number.isSafeInteger(child)) return false;
    } else if (typeof child !== rule) return false;
  }
  return true;
}
export interface NonCanonicalMetadata {
  execution_id: string;
  id: number;
  timestamp_ms: number;
  error: 'non-canonical CPAMP metadata encoding';
}
// Flags have no CPAMP columns: independently encode CPAMP's envelope metadata in Prox's bit layout.
function metadataFlags(
  metadata: Record<string, unknown>,
  checks: Preconditions,
  row: CpampSourceRow
) {
  let flags = identifier(metadata.usage_presence) === 'reported' ? USAGE_FLAG.presenceReported : 0;
  const fields = object(metadata.usage_fields);
  if (
    metadata.usage_fields &&
    !Array.isArray(metadata.usage_fields) &&
    typeof metadata.usage_fields === 'object' &&
    Object.keys(USAGE_FIELD_BITS).every(
      (key) => fields[key] == null || typeof fields[key] === 'boolean'
    )
  ) {
    flags |= USAGE_FLAG.fieldsPresent;
    for (const [key, bit] of Object.entries(USAGE_FIELD_BITS))
      if (fields[key] === true) flags |= bit;
  }
  const b = object(metadata.token_breakdown),
    input = object(b.input),
    output = object(b.output);
  const canonical = [
    input.total_tokens,
    input.uncached_tokens,
    input.cache_read_tokens,
    input.cache_write_tokens,
    output.total_tokens,
    output.reasoning_tokens,
    b.total_tokens,
  ];
  const complete =
    metadata.accounting_version === 2 &&
    b.schema_version === 2 &&
    goTrim(string(b.quality)) === 'complete' &&
    b.unclassified_tokens === 0 &&
    [...canonical, output.non_reasoning_tokens].every(count) &&
    input.total_tokens ===
      Number(input.uncached_tokens) +
        Number(input.cache_read_tokens) +
        Number(input.cache_write_tokens) &&
    output.total_tokens === Number(output.non_reasoning_tokens) + Number(output.reasoning_tokens) &&
    b.total_tokens === Number(input.total_tokens) + Number(output.total_tokens);
  if (complete) {
    flags |= USAGE_FLAG.breakdownComplete;
    if (counters.some((key, i) => row[key] !== canonical[i])) checks.invalidBreakdownIdentity++;
  } else checks.incompleteBreakdown++;
  return flags;
}
export function cpampReference(
  row: CpampSourceRow,
  checks: Preconditions,
  seen: Set<string>
): CpampEventReference | NonCanonicalMetadata | null {
  if (!row.valid_json) checks.invalidJson++;
  const extracted = JSON.parse(row.metadata) as unknown[];
  const metadata = Object.fromEntries(CPAMP_METADATA_KEYS.map((key, i) => [key, extracted[i]]));
  const execution = identifier(metadata.execution_id);
  const duplicate = seen.has(execution);
  if (!execution) checks.missingExecutionId++;
  else if (duplicate) checks.duplicateExecutionId++;
  else seen.add(execution);
  if (!canonicalMetadata(metadata, METADATA_SHAPE, true))
    return {
      execution_id: execution,
      id: row.id,
      timestamp_ms: Number(row.timestamp_ms),
      error: 'non-canonical CPAMP metadata encoding',
    };
  const validTimestamp =
    Number.isSafeInteger(row.timestamp_ms) && Math.abs(Number(row.timestamp_ms)) <= 8.64e15;
  const validTokens = counters.every((key) => count(row[key]));
  if (!validTimestamp) checks.invalidTimestamp++;
  if (!validTokens) checks.invalidTokens++;
  if (row.latency_ms === null || Number(row.latency_ms) <= 0) checks.nonPositiveLatency++;
  if (!execution || duplicate || !validTimestamp || !validTokens) return null;
  const requested = string(row.requested_model) || string(row.model);
  const snapshot = nullable(row.account_snapshot);
  return {
    execution_id: execution,
    instance: identifier(metadata.instance_id) || null,
    ts_ms: Number(row.timestamp_ms),
    provider: nullable(row.provider),
    account:
      snapshot === null || snapshot === ''
        ? (nullable(row.auth_label_snapshot) ?? nullable(row.auth_index))
        : snapshot,
    account_label: nullable(row.auth_label_snapshot),
    api_key_hash: nullable(row.api_key_hash),
    model: cpampModel(requested),
    requested_model: requested,
    billing_model: string(row.resolved_model) || requested,
    tier: string(row.service_tier),
    failed: Number(row.failed),
    status_code: row.fail_status_code as number | null,
    latency_ms: row.latency_ms as number | null,
    ttft_ms: row.ttft_ms as number | null,
    ttft_method: timingMethod(metadata.ttft_method),
    ...(Object.fromEntries(counters.map((key) => [key, row[key]])) as Pick<
      EventValues,
      (typeof counters)[number]
    >),
    usage_flags: metadataFlags(metadata, checks, row),
    record_kind:
      metadata.record_kind === 'execution'
        ? RECORD_KIND.execution
        : metadata.record_kind === 'supplementary'
          ? RECORD_KIND.supplementary
          : RECORD_KIND.unknown,
  };
}
