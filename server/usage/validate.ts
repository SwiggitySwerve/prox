// JSON and query bounds belong at the HTTP boundary, before admission.
import type { AnalyticsQuery, RegisteredAnalyticsModel } from '../../src/domain/analytics/types';

export interface UsageAnalyticsQuery extends AnalyticsQuery {
  catalog: RegisteredAnalyticsModel[];
  /** Authenticated parity/debug escape hatch; never affects the response schema. */
  debug_force_raw?: boolean;
}
export class AnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new AnalyticsError(message, 400);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`Unknown field: ${key}`);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= max && !/\p{Cc}/u.test(value);
}
export function validateAnalyticsQuery(input: unknown): UsageAnalyticsQuery {
  const q = object(input);
  keys(q, [
    'from_ms',
    'to_ms',
    'time_zone',
    'granularity',
    'provider',
    'model',
    'outcome',
    'search',
    'limit',
    'before_ms',
    'before_id',
    'catalog',
    'debug_force_raw',
  ]);
  if (
    !integer(q.from_ms) ||
    !integer(q.to_ms) ||
    q.from_ms <= 0 ||
    q.to_ms <= q.from_ms ||
    q.to_ms - q.from_ms > 31 * 86400000 ||
    q.to_ms > 253402300799999
  )
    invalid('range must be positive and at most 31 days');
  if (q.granularity !== 'hour' && q.granularity !== 'day')
    invalid('granularity must be hour or day');
  if (q.outcome !== 'all' && q.outcome !== 'success' && q.outcome !== 'failed')
    invalid('outcome must be all, success or failed');
  if (q.time_zone !== 'UTC') invalid('time_zone must be UTC');
  if (q.limit != null && (!integer(q.limit) || q.limit < 0 || q.limit > 200))
    invalid('limit must be between 1 and 200 when supplied');
  const ms = q.before_ms ?? undefined;
  const id = q.before_id ?? undefined;
  if ((ms === undefined) !== (id === undefined))
    invalid('before_ms and before_id must be supplied together');
  if (
    ms !== undefined &&
    (!integer(ms) || !integer(id) || ms < q.from_ms || ms >= q.to_ms || id <= 0)
  )
    invalid('invalid cursor');
  for (const [key, bound] of [
    ['search', 256],
    ['model', 256],
    ['provider', 128],
  ] as const)
    if (q[key] != null && !text(q[key], bound)) invalid('search or filter exceeds bounds');
  if (q.debug_force_raw !== undefined && typeof q.debug_force_raw !== 'boolean')
    invalid('debug_force_raw must be boolean');
  const catalog = q.catalog ?? [];
  if (!Array.isArray(catalog) || catalog.length > 1000)
    invalid('catalog must contain at most 1000 models');
  for (const raw of catalog) {
    const m = object(raw);
    keys(m, ['instance_id', 'instance_label', 'provider', 'id']);
    for (const [key, bound] of [
      ['instance_id', 256],
      ['instance_label', 256],
      ['id', 256],
      ['provider', 128],
    ] as const) {
      const value = m[key] ?? '';
      if (!text(value, bound) || (key !== 'instance_label' && !value.trim()))
        invalid('invalid catalog entry');
    }
  }
  return {
    from_ms: q.from_ms,
    to_ms: q.to_ms,
    time_zone: 'UTC',
    granularity: q.granularity,
    outcome: q.outcome as AnalyticsQuery['outcome'],
    provider: (q.provider ?? '') as string,
    model: (q.model ?? '') as string,
    search: (q.search ?? '') as string,
    limit: (q.limit as number) || 100,
    ...(ms === undefined ? {} : { before_ms: ms as number, before_id: id as number }),
    ...(q.debug_force_raw === undefined ? {} : { debug_force_raw: q.debug_force_raw as boolean }),
    catalog: catalog.map((m) => ({ ...m, instance_label: m.instance_label ?? '' })),
  };
}
/** JSON.parse rejects both trailing JSON values and trailing non-whitespace. */
export function parseAnalyticsQuery(body: string): UsageAnalyticsQuery {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    invalid('Invalid JSON body');
  }
  return validateAnalyticsQuery(value);
}
