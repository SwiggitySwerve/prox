import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UsageStore, openUsageReader } from '../../server/usage/store';
import { normalizeUsagePayload } from '../../server/usage/normalize';
import { parseRateBook, priceRevision, type RateBook } from '../../server/usage/rates';
import { validateAnalyticsQuery } from '../../server/usage/validate';
import type { NormalizedEvent } from '../../server/usage/types';
import { usagePayload } from '../fixtures/usagePayloads';

export const BASE = 1794000000000;
export const query = (overrides = {}) =>
  validateAnalyticsQuery({
    from_ms: BASE,
    to_ms: BASE + 86400000,
    time_zone: 'UTC',
    granularity: 'hour',
    outcome: 'all',
    ...overrides,
  });
export const rates = { input: 2, output: 4, cache_read: 0.5, cache_write: null };
export const book = parseRateBook({ version: 1, models: { 'claude-test-4': rates } });
export const rateState = (value: RateBook = book, error: string | null = null) => ({
  book: value,
  price_revision: priceRevision(value),
  loaded_at_ms: BASE,
  checked_at_ms: BASE,
  error,
});
export function event(index: number, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const result = normalizeUsagePayload(JSON.stringify(usagePayload()));
  if (result.kind !== 'event') throw new Error('Fixture must be valid');
  return {
    ...result.event,
    executionId: `execution-${String(index).padStart(24, '0')}`,
    tsMs: BASE + 1,
    ...overrides,
  };
}
export function analyticsStore() {
  const directory = mkdtempSync('/dev/shm/prox-usage-query-test-');
  const path = join(directory, 'usage.sqlite');
  const store = new UsageStore({ events: path, raw: null });
  const db = openUsageReader(path);
  return {
    path,
    directory,
    store,
    db,
    insert(events: NormalizedEvent[], ingest: 0 | 1 | 2 | 3 = 0) {
      store.insert(
        events.map((event) => ({ event, raw: null })),
        ingest
      );
    },
    close() {
      db.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
