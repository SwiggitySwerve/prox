// Rate-book boundary: validation, canonical revision and last-good file reloads.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const RATE_FIELDS = ['input', 'output', 'cache_read', 'cache_write'] as const;
export type RateValues = Readonly<Record<(typeof RATE_FIELDS)[number], number | null>>;
export interface ContextRate extends RateValues {
  readonly above_input_tokens: number;
}
export interface ServiceRate extends RateValues {
  /** Export order is mode, then emitted service tier; the latter is the inventory label. */
  readonly names: readonly string[];
}
export interface ModelRate extends RateValues {
  readonly source?: string;
  readonly updated_at_ms?: number;
  readonly context_tiers: readonly ContextRate[];
  readonly service_tiers: readonly ServiceRate[];
}
export interface RateBook {
  readonly version: 1;
  readonly models: Readonly<Record<string, ModelRate>>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported`);
  }
}
function values(value: Record<string, unknown>, path: string): RateValues {
  const result = {} as Record<(typeof RATE_FIELDS)[number], number | null>;
  for (const key of RATE_FIELDS) {
    const rate = value[key];
    if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
      throw new Error(`${path}.${key} must be null or a finite non-negative rate`);
    }
    result[key] = rate;
  }
  return Object.freeze(result);
}
function rows(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

/** Null tier fields inherit the base. Null base fields are unconfigured, never free. */
export function applyRateOverride(base: RateValues, override: RateValues): RateValues {
  return Object.fromEntries(
    RATE_FIELDS.map((key) => [key, override[key] ?? base[key]])
  ) as RateValues;
}

export function parseRateBook(input: unknown): RateBook {
  const root = object(input, 'book');
  keys(root, ['version', 'models'], 'book');
  if (root.version !== 1) throw new Error('book.version must be 1');
  const models: Record<string, ModelRate> = Object.create(null);
  for (const [name, raw] of Object.entries(object(root.models, 'book.models'))) {
    if (!name.trim() || name !== name.trim())
      throw new Error('model names must be trimmed and nonempty');
    const path = `models.${name}`;
    const model = object(raw, path);
    keys(
      model,
      [...RATE_FIELDS, 'source', 'updated_at_ms', 'context_tiers', 'service_tiers'],
      path
    );
    const base = values(model, path);
    if (model.source !== undefined && typeof model.source !== 'string') {
      throw new Error(`${path}.source must be a string`);
    }
    if (
      model.updated_at_ms !== undefined &&
      (!Number.isSafeInteger(model.updated_at_ms) || Number(model.updated_at_ms) < 0)
    ) {
      throw new Error(`${path}.updated_at_ms must be a non-negative safe integer`);
    }
    const thresholds = new Set<number>();
    const context = rows(model.context_tiers, `${path}.context_tiers`)
      .map((raw) => {
        const row = object(raw, `${path}.context_tiers`);
        keys(row, [...RATE_FIELDS, 'above_input_tokens'], path);
        const threshold = row.above_input_tokens;
        if (
          typeof threshold !== 'number' ||
          !Number.isSafeInteger(threshold) ||
          threshold <= 0 ||
          thresholds.has(threshold)
        ) {
          throw new Error(`${path}: context thresholds must be distinct positive safe integers`);
        }
        thresholds.add(threshold);
        return Object.freeze({ ...values(row, path), above_input_tokens: threshold });
      })
      .sort((a, b) => a.above_input_tokens - b.above_input_tokens);
    const claimed = new Set<string>();
    const service = rows(model.service_tiers, `${path}.service_tiers`).map((raw) => {
      const row = object(raw, `${path}.service_tiers`);
      keys(row, [...RATE_FIELDS, 'names'], path);
      if (
        !Array.isArray(row.names) ||
        row.names.length === 0 ||
        row.names.some((name) => typeof name !== 'string' || !name.trim())
      ) {
        throw new Error(`${path}: service tier names must be nonempty strings`);
      }
      const names = [...new Set((row.names as string[]).map((name) => name.trim().toLowerCase()))];
      for (const name of names) {
        if (claimed.has(name)) throw new Error(`${path}: duplicate service tier name ${name}`);
        claimed.add(name);
      }
      return Object.freeze({ ...values(row, path), names: Object.freeze(names) });
    });
    models[name] = Object.freeze({
      ...base,
      ...(model.source === undefined ? {} : { source: model.source as string }),
      ...(model.updated_at_ms === undefined
        ? {}
        : { updated_at_ms: model.updated_at_ms as number }),
      context_tiers: Object.freeze(context),
      service_tiers: Object.freeze(service),
    });
  }
  return Object.freeze({ version: 1, models: Object.freeze(models) });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON sorts object keys; provenance never changes the monetary revision. */
export function priceRevision(book: RateBook): string {
  const models = Object.fromEntries(
    Object.entries(book.models).map(([name, model]) => [
      name,
      {
        ...Object.fromEntries(RATE_FIELDS.map((key) => [key, model[key]])),
        context_tiers: model.context_tiers,
        service_tiers: model.service_tiers,
      },
    ])
  );
  return createHash('sha256')
    .update(canonical({ version: book.version, models }))
    .digest('hex');
}

export interface RateBookState {
  readonly book: RateBook | null;
  readonly price_revision: string | null;
  readonly loaded_at_ms: number | null;
  readonly checked_at_ms: number;
  readonly error: string | null;
}
export interface RateBookIO {
  now(): number;
  mtime(path: string): number;
  read(path: string): string;
}

/** Call load at the query boundary; retain one immutable snapshot for that entire query. */
export function createRateBookLoader(path: string, io: Partial<RateBookIO> = {}) {
  const clock = io.now ?? Date.now;
  const mtime = io.mtime ?? ((file) => statSync(file).mtimeMs);
  const read = io.read ?? ((file) => readFileSync(file, 'utf8'));
  let attemptedMtime: number | undefined;
  let state: RateBookState = {
    book: null,
    price_revision: null,
    loaded_at_ms: null,
    checked_at_ms: 0,
    error: null,
  };
  return {
    load(): RateBookState {
      const checked = clock();
      try {
        const modified = mtime(path);
        if (modified !== attemptedMtime) {
          const book = parseRateBook(JSON.parse(read(path)));
          const revision = priceRevision(book);
          attemptedMtime = modified;
          state = {
            book,
            price_revision: revision,
            loaded_at_ms: checked,
            checked_at_ms: checked,
            error: null,
          };
        } else {
          state = { ...state, checked_at_ms: checked, error: null };
        }
      } catch (error) {
        // Retry failures even if an editor restores the old mtime or a transient read failed.
        attemptedMtime = undefined;
        state = {
          ...state,
          checked_at_ms: checked,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return Object.freeze(state);
    },
  };
}
