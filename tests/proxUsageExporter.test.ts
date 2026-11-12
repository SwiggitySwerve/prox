import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageExporter } from '../server/usage/exporter';
import { exporterRates } from '../server/usage/pricing';
import { parseRateBook } from '../server/usage/rates';
import { createClientAliasLoader, parseClientAliases } from '../server/usage/clientAliases';
import { createUsageStatusHandler } from '../server/usage/status';
import { UsageWriter } from '../server/usage/writer';
import { UsageStore, migrateUsageDatabase } from '../server/usage/store';
import { USAGE_MIGRATIONS } from '../server/usage/schema';
import { event, analyticsStore } from './helpers/usageAnalytics';
import { createCpamp } from './fixtures/cpampUsage';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const rates = { input: 2, output: 4, cache_read: 0.5, cache_write: 3 };
const book = (override = {}) =>
  parseRateBook({
    version: 1,
    models: {
      'claude-test-4': { ...rates, ...override },
    },
  });
const emptyAliases = new Map<string, string>();

test('lifetime groups preserve original counters, all-call latency and positive-only TTFT', () => {
  const rows = [
    event(1, { account: 'account', apiKeyHash: null }),
    event(2, {
      account: 'account',
      apiKeyHash: null,
      reportedLatencyMs: null,
      reportedTtftMs: 0,
      reportedInputTokens: 0,
      reportedOutputTokens: 0,
      reportedReasoningTokens: 0,
      reportedTotalTokens: 0,
    }),
    event(3, { failed: true, apiKeyHash: 'a'.repeat(64), reportedTtftMs: -1 }),
  ];
  const fold = new UsageExporter((visit) => rows.forEach(visit));
  fold.refresh(book());
  const snapshot = fold.snapshot(emptyAliases);
  expect(snapshot).toMatchObject({
    schema_version: 1,
    missing_reported_counters: 0,
    models_priced: 1,
    newest_event_time_seconds: rows[0].tsMs / 1000,
  });
  expect(snapshot.groups[0]).toMatchObject({
    provider: 'claude',
    model: 'client-claude',
    account: 'account',
    client: 'unknown',
    status: 'success',
    requests: 2,
    tokens: { input: 100, output: 140, cached: 0, reasoning: 60 },
    cache: { read: 1600, write: 100 },
    latency_seconds_sum: 1.5,
    latency_seconds_count: 2,
    ttft_seconds_sum: 0.42,
    ttft_seconds_count: 1,
    zero_token_success: 1,
  });
  // Cost uses original output plus normalized uncached input/cache, as the Python SQL did.
  expect(snapshot.groups[0].cost_usd).toBeCloseTo(
    (200 * 2 + 140 * 4 + 1600 * 0.5 + 100 * 3) / 1e6,
    12
  );
  expect(snapshot.groups[1]).toMatchObject({
    client: 'key aaaaaaaa',
    status: 'failed',
    ttft_seconds_count: 0,
  });
  expect(JSON.stringify(snapshot)).not.toContain('a'.repeat(64));
  expect(fold.snapshot(new Map([['a'.repeat(64), 'Named client']])).groups[1].client).toBe(
    'Named client'
  );
});

test('price-only and alias edits need no scan; threshold edits refold per-event bands', () => {
  const rows = [event(1), event(2)];
  let scans = 0;
  const fold = new UsageExporter((visit) => {
    scans += 1;
    rows.forEach(visit);
  });
  fold.refresh(book());
  const initial = fold.snapshot(emptyAliases).groups[0].cost_usd!;
  fold.refresh(book({ output: 8 }));
  expect(scans).toBe(1);
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(initial + (280 * 4) / 1e6, 12);
  fold.refresh(book({ context_tiers: [{ ...rates, input: 20, above_input_tokens: 949 }] }));
  expect(scans).toBe(2);
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(
    initial + (200 * 18) / 1e6,
    12
  );
  fold.refresh(book({ context_tiers: [{ ...rates, input: 20, above_input_tokens: 950 }] }));
  expect(scans).toBe(3);
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(initial, 12); // strictly above
});

test('exporter keeps -fast priority, context precedence, defaults and billing-only lookup', () => {
  const b = book({
    service_tiers: [{ ...rates, input: 10, names: ['priority', 'fast'] }],
    context_tiers: [{ ...rates, input: 20, above_input_tokens: 500 }],
  });
  expect(exporterRates(b, 'claude-test-4', 'alias-fast', '', null)?.input).toBe(10);
  expect(exporterRates(b, 'claude-test-4', 'alias-fast', 'priority', 500)?.input).toBe(20);
  expect(exporterRates(b, 'claude-test-4', 'alias-fast', 'priority', 600)?.input).toBe(2);
  expect(exporterRates(b, 'missing', 'claude-test-4', 'priority', null)).toBeNull();
  expect(
    exporterRates(book({ cache_read: null, cache_write: null }), 'claude-test-4', '', '', null)
  ).toEqual({ ...rates, cache_read: 0.2, cache_write: 2 });
  expect(
    exporterRates(book({ cache_read: 0, cache_write: 0 }), 'claude-test-4', '', '', null)
      ?.cache_read
  ).toBe(0);
});

test('store notifies the fold only after commits, not duplicates or rolled-back imports', () => {
  const f = analyticsStore();
  cleanups.push(() => f.close());
  const fold = new UsageExporter((visit) => f.store.scanExporterEvents(visit));
  fold.refresh(book());
  f.store.onCommit = (events, repaired) => {
    if (repaired) fold.invalidate();
    else events.forEach((row) => fold.add(row));
  };
  f.insert([event(1)]);
  f.insert([event(1)]);
  expect(fold.snapshot(emptyAliases).groups[0].requests).toBe(1);
  const instrument = new Database(f.path);
  cleanups.push(() => instrument.close());
  instrument.exec(
    "CREATE TRIGGER fail_cursor BEFORE INSERT ON meta WHEN NEW.key='import:cpamp:last_id' BEGIN SELECT RAISE(ABORT, 'synthetic'); END"
  );
  expect(() => f.store.importChunk([event(2)], 1)).toThrow();
  expect(fold.snapshot(emptyAliases).groups[0].requests).toBe(1);
  const restarted = new UsageExporter((visit) => f.store.scanExporterEvents(visit));
  restarted.refresh(book());
  expect(restarted.snapshot(emptyAliases)).toEqual(fold.snapshot(emptyAliases));
});

test('private aliases reload on mtime and retain last good names on invalid or public edits', () => {
  const root = mkdtempSync('/dev/shm/prox-alias-test-');
  cleanups.push(() => rmSync(root, { recursive: true }));
  const path = join(root, 'client-aliases.json');
  const loader = createClientAliasLoader(path);
  expect(loader.load().error).toBe(true);
  const put = (alias: string, time: number) => {
    writeFileSync(
      path,
      JSON.stringify({ client_alias: [{ api_key_hash: 'a'.repeat(64), alias }] }),
      { mode: 0o600 }
    );
    utimesSync(path, time, time);
  };
  put('First', 100);
  expect(loader.load().aliases.get('a'.repeat(64))).toBe('First');
  put('Second', 101);
  expect(loader.load().aliases.get('a'.repeat(64))).toBe('Second');
  chmodSync(path, 0o644);
  expect(loader.load()).toMatchObject({ error: true });
  expect(loader.load().aliases.get('a'.repeat(64))).toBe('Second');
  chmodSync(path, 0o600);
  writeFileSync(path, '{');
  expect(loader.load().error).toBe(true);
  expect(() =>
    parseClientAliases({ client_alias: [{ api_key_hash: 'raw-key', alias: 'Bad' }] })
  ).toThrow();
  put('Recovered', 102);
  expect(loader.load().aliases.get('a'.repeat(64))).toBe('Recovered');
});

test('exporter bearer boundary reports per-source subscription and nullable event age', async () => {
  const root = mkdtempSync('/dev/shm/prox-exporter-http-');
  cleanups.push(() => rmSync(root, { recursive: true }));
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, 'synthetic-key');
  const fold = new UsageExporter(() => {});
  fold.refresh(book());
  const handler = createUsageStatusHandler({
    keyFile,
    healthy: () => true,
    now: () => 10_000,
    sources: () =>
      [
        { instance: 'claude-primary', state: 'subscribed', lastEventAtMs: 8000 },
        { instance: 'codex-primary', state: 'backoff', lastEventAtMs: null },
      ] as ReturnType<Parameters<typeof createUsageStatusHandler>[0]['sources']>,
    writer: () => ({
      backlog: 0,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      rawBufferFailures: 0,
      gaps: 0,
    }),
    exporter: async () => ({
      ...fold.snapshot(emptyAliases),
      rate_book_error: false,
      client_alias_error: false,
    }),
  });
  const request = (method = 'GET', auth = true) =>
    new Request('http://127.0.0.1/v1/exporter', {
      method,
      headers: auth ? { Authorization: 'Bearer synthetic-key' } : {},
    });
  expect((await handler(request('GET', false))).status).toBe(401);
  expect((await handler(request('POST'))).status).toBe(405);
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    sources: [
      {
        instance: 'claude-primary',
        state: 'subscribed',
        subscribed: true,
        last_event_age_seconds: 2,
      },
      {
        instance: 'codex-primary',
        state: 'backoff',
        subscribed: false,
        last_event_age_seconds: null,
      },
    ],
  });
  fold.add(event(1, { reportedInputTokens: null }));
  expect((await handler(request())).status).toBe(503);
});

test('worker reconciles original metadata for schema-1 rows, then exports and hot-reloads files', async () => {
  const root = mkdtempSync('/dev/shm/prox-exporter-worker-');
  cleanups.push(() => rmSync(root, { recursive: true }));
  const source = createCpamp(join(root, 'cpamp.sqlite'), 1);
  cleanups.push(() => source.db.close());
  const path = join(root, 'usage.sqlite');
  // Seed through the current contract, then simulate schema-1 metadata/cursor state.
  const store = new UsageStore({ events: path, raw: null });
  const old = event(1, {
    executionId: JSON.parse(
      source.db.query<{ raw_json: string }, []>('SELECT raw_json FROM usage_events').get()!.raw_json
    ).execution_id,
  });
  store.insert([{ event: old, raw: null }], 0);
  store.setMeta('import:cpamp:last_id', '1');
  store.close();
  const instrument = new Database(path);
  instrument.exec(
    'UPDATE event_detail SET reported_input=NULL, reported_cached=NULL, reported_output=NULL, reported_reasoning=NULL, reported_total=NULL, reported_latency=NULL, reported_ttft=NULL'
  );
  instrument.close();
  const ratePath = join(root, 'rates.json'),
    aliasPath = join(root, 'client-aliases.json');
  writeFileSync(ratePath, JSON.stringify(book()));
  writeFileSync(aliasPath, JSON.stringify({ client_alias: [] }), { mode: 0o600 });
  const workerPath = join(root, 'worker.ts');
  writeFileSync(
    workerPath,
    `import { startUsageWriterWorker } from ${JSON.stringify(join(import.meta.dir, '../server/usage/writerRuntime.ts'))}; startUsageWriterWorker({readPsi: () => 'full avg10=0.00 avg60=0', bytesPerSecond: 1e15});`
  );
  const writer = new UsageWriter(workerPath);
  cleanups.push(() => writer.close());
  await writer.init(
    { events: path, raw: null },
    [],
    Date.now(),
    { cpampPath: join(root, 'cpamp.sqlite') },
    { rateBookPath: ratePath, clientAliasesPath: aliasPath }
  );
  expect((await writer.exporterSnapshot()).missing_reported_counters).toBe(1);
  await writer.startJob('reconcile');
  for (let i = 0; i < 200; i += 1) {
    if ((await writer.jobReport())?.finishedAtMs) break;
    await Bun.sleep(5);
  }
  expect((await writer.jobReport())?.state).toBe('succeeded');
  const snapshot = await writer.exporterSnapshot();
  expect(snapshot.missing_reported_counters).toBe(0);
  expect(snapshot.groups[0]).toMatchObject({ requests: 1, tokens: { input: 100, output: 200 } });
  writeFileSync(
    aliasPath,
    JSON.stringify({ client_alias: [{ api_key_hash: old.apiKeyHash, alias: 'New name' }] })
  );
  utimesSync(aliasPath, 100, 100);
  expect((await writer.exporterSnapshot()).groups[0].client).toBe('New name');
  writeFileSync(ratePath, JSON.stringify(book({ output: 8 })));
  utimesSync(ratePath, 101, 101);
  expect((await writer.exporterSnapshot()).groups[0].cost_usd).toBeGreaterThan(
    snapshot.groups[0].cost_usd!
  );
  // A metadata-only upgrade of an actual old schema leaves existing event rows in place.
  const legacy = new Database(join(root, 'legacy.sqlite'));
  migrateUsageDatabase(legacy, USAGE_MIGRATIONS.slice(0, 1));
  migrateUsageDatabase(legacy);
  expect(legacy.query('PRAGMA table_info(event_detail)').all()).toContainEqual(
    expect.objectContaining({ name: 'reported_input' })
  );
  legacy.close();
});
