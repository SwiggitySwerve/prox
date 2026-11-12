// Reproducible synthetic P5 budget check. Every database/key is temporary and lives in tmpfs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageStore } from '../server/usage/store';
import { createAnalyticsHandler } from '../server/usage/handler';
import { parseRateBook, priceRevision } from '../server/usage/rates';
import { event, BASE } from '../tests/helpers/usageAnalytics';

const directory = mkdtempSync('/dev/shm/prox-query-budget-');
const dbPath = join(directory, 'usage.sqlite');
const keyFile = join(directory, 'key');
writeFileSync(keyFile, 'synthetic-benchmark-key');
const store = new UsageStore({ events: dbPath, raw: null });
const models = Array.from({ length: 40 }, (_, i) => `synthetic-model-${i}`);
const baseRates = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 };
const book = parseRateBook({
  version: 1,
  models: Object.fromEntries(
    models.map((name) => [
      name,
      {
        ...baseRates,
        context_tiers: [
          { above_input_tokens: 272000, input: 4, output: 15, cache_read: 0.2, cache_write: 5 },
        ],
        service_tiers: [
          { names: ['priority', 'fast'], input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        ],
      },
    ])
  ),
});
const snapshot = {
  book,
  price_revision: priceRevision(book),
  loaded_at_ms: BASE,
  checked_at_ms: BASE,
  error: null,
};
const handler = createAnalyticsHandler({ dbPath, keyFile, rateBook: { load: () => snapshot } });
const rows = 32000 * 30;
const prototype = event(0);
const makeEvent = (i: number, timestamp: number) => {
  // Stable non-correlated variation across model, credential, client, tier and context band.
  const hash = Math.imul(i + 1, 2654435761) >>> 0;
  const model = models[hash % 40];
  const input =
    Math.floor(hash / 19200) % 10 === 0 ? 272001 + (hash % 200000) : 1000 + (hash % 200000);
  const output = 100 + (hash % 4000);
  return {
    ...prototype,
    executionId: `synthetic-execution-${i}`,
    tsMs: timestamp,
    model,
    billingModel: model,
    requestedModel: `${model}(high)`,
    provider: hash % 3 ? 'codex' : 'claude',
    instance: hash % 3 ? 'codex-primary' : 'claude-primary',
    account: `account-${Math.floor(hash / 40) % 6}`,
    accountLabel: `Account ${Math.floor(hash / 40) % 6}`,
    apiKeyHash: `${Math.floor(hash / 240) % 5}`.padStart(64, '0'),
    userAgent: `client-${Math.floor(hash / 240) % 5}/1.0`,
    tier:
      Math.floor(hash / 960) % 20 < 14
        ? 'standard'
        : Math.floor(hash / 960) % 20 < 18
          ? 'priority'
          : 'fast',
    latencyMs: 100 + (hash % 90000),
    ttftMs: hash % 11 ? hash % 10000 : null,
    failed: hash % 23 === 0,
    tokens: {
      inputTotal: input,
      inputUncached: input - 700,
      cacheRead: 600,
      cacheWrite: 100,
      outputTotal: output,
      reasoning: Math.floor(output / 3),
      total: input + output,
    },
  };
};
let ingestTimer: ReturnType<typeof setInterval> | undefined;
try {
  console.log(JSON.stringify({ stage: 'populate', rows, path: directory, runtime: Bun.version }));
  const start = performance.now();
  for (let i = 0; i < rows; i += 1000) {
    store.insert(
      Array.from({ length: Math.min(1000, rows - i) }, (_, n) => ({
        event: makeEvent(i + n, BASE + Math.floor(((i + n) * 30 * 86400000) / rows)),
        raw: null,
      })),
      0
    );
    if (i % 160000 === 0) {
      console.log(JSON.stringify({ stage: 'inserted', count: i + 1000 }));
      await Bun.sleep(0);
    }
  }
  console.log(JSON.stringify({ stage: 'populated', ms: performance.now() - start }));
  let inserted = rows;
  ingestTimer = setInterval(() => {
    // About 34k/day live ingest is 0.4/s; use 4/s while measuring for a conservative check.
    store.insert([{ event: makeEvent(inserted++, BASE + 30 * 86400000 - 1), raw: null }], 0);
  }, 250);
  const request = (days: number, granularity: 'day' | 'hour') =>
    new Request('http://127.0.0.1/v1/analytics', {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-benchmark-key' },
      body: JSON.stringify({
        from_ms: BASE + (30 - days) * 86400000,
        to_ms: BASE + 30 * 86400000,
        time_zone: 'UTC',
        granularity,
        outcome: 'all',
        limit: 100,
      }),
    });
  for (const [days, granularity] of [
    [1, 'hour'],
    [30, 'day'],
    [30, 'hour'],
  ] as const) {
    const durations: number[] = [];
    for (let run = 0; run < 53; run++) {
      const at = performance.now();
      const response = await handler(request(days, granularity));
      if (response.status !== 200) throw new Error(await response.text());
      await response.text();
      const ms = performance.now() - at;
      if (run >= 3) durations.push(ms);
      if (run % 10 === 0) console.log(JSON.stringify({ stage: 'run', days, granularity, run, ms }));
    }
    durations.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        stage: 'result',
        synthetic: true,
        days,
        granularity,
        rows,
        warmRuns: 50,
        p50_ms: durations[24],
        p95_ms: durations[47],
        max_ms: durations[49],
        concurrentIngest: inserted - rows,
      })
    );
  }
} finally {
  if (ingestTimer) clearInterval(ingestTimer);
  handler.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
