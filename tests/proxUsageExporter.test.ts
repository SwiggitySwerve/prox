import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageExporter } from '../server/usage/exporter';
import { parseRateBook } from '../server/usage/rates';
import { runCpampJob } from '../server/usage/importCpamp';
import { openUsageReader } from '../server/usage/store';
import { fakeIo } from './helpers/usageIo';
import { createCpamp, cpampRow } from './fixtures/cpampUsage';
import labelFixture from './fixtures/usageExporterLabels.json';
import { queryAnalytics } from '../server/usage/analytics';
import { createClientAliasLoader, parseClientAliases } from '../server/usage/clientAliases';
import { createUsageStatusHandler } from '../server/usage/status';
import { UsageWriter } from '../server/usage/writer';
import { UsageStore } from '../server/usage/store';
import { USAGE_MIGRATIONS } from '../server/usage/schema';
import { RECORD_KIND } from '../server/usage/types';
import { event, analyticsStore, query, rateState } from './helpers/usageAnalytics';

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
const zeroTokens = {
  inputTotal: 0,
  inputUncached: 0,
  outputTotal: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
};

test('fold matches independent canonical event totals and excludes supplementary records', () => {
  const rows = [
    event(1, { account: 'account', apiKeyHash: null }),
    event(2, {
      account: 'account',
      apiKeyHash: null,
      tokens: zeroTokens,
      latencyMs: null,
      ttftMs: 0,
    }),
    event(3, { failed: true, apiKeyHash: 'a'.repeat(64), ttftMs: null }),
    event(4, { recordKind: RECORD_KIND.supplementary, tsMs: 9e12 }),
  ];
  const fold = new UsageExporter((visit) => rows.forEach(visit));
  fold.refresh(book());
  const snapshot = fold.snapshot(emptyAliases);
  expect(snapshot).toMatchObject({
    schema_version: 1,
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
    tokens: { input: 950, output: 200, cached: 800, reasoning: 60 },
    cache: { read: 800, write: 50 },
    latency_seconds_sum: 1.5,
    latency_seconds_count: 1,
    ttft_seconds_sum: 0.42,
    ttft_seconds_count: 1,
    zero_token_success: 1,
  });
  // Independent arithmetic over the fixture's canonical breakdown, not the pricing implementation.
  expect(snapshot.groups[0].cost_usd).toBeCloseTo(
    (100 * 2 + 200 * 4 + 800 * 0.5 + 50 * 3) / 1e6,
    12
  );
  expect(snapshot.groups[1]).toMatchObject({
    client: 'key aaaaaaaa',
    status: 'failed',
    ttft_seconds_count: 0,
  });
  expect(snapshot.groups.reduce((n, g) => n + g.requests, 0)).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain('a'.repeat(64));
  expect(fold.snapshot(new Map([['a'.repeat(64), 'Named client']])).groups[1].client).toBe(
    'Named client'
  );
});

test('ordinary prices reprice without scans; thresholds and candidate membership refold', () => {
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
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(initial + (400 * 4) / 1e6, 12);
  fold.refresh(book({ context_tiers: [{ ...rates, input: 20, above_input_tokens: 949 }] }));
  expect(scans).toBe(2);
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(
    initial + (200 * 18) / 1e6,
    12
  );
  fold.refresh(book({ context_tiers: [{ ...rates, input: 20, above_input_tokens: 950 }] }));
  expect(scans).toBe(3);
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(initial, 12);
  const changed = parseRateBook({
    version: 1,
    models: {
      ...book().models,
      'client-claude': { ...rates, context_tiers: [{ ...rates, above_input_tokens: 1 }] },
    },
  });
  fold.refresh(changed);
  expect(scans).toBe(4);
  // A configured billing candidate stops fallback even when an alias has a lower threshold.
  expect(fold.snapshot(emptyAliases).groups[0].cost_usd).toBeCloseTo(initial, 12);
});

test('exporter totals equal analytics for each provider/outcome with P4 pricing and reloads', () => {
  const f = analyticsStore();
  cleanups.push(() => f.close());
  const rows = [
    event(1, { model: 'canonical', requestedModel: 'alias-fast', billingModel: 'missing' }),
    event(2, {
      model: 'canonical',
      requestedModel: 'alias-fast',
      billingModel: 'missing',
      tier: 'priority',
      failed: true,
    }),
    event(3, {
      model: 'canonical',
      requestedModel: 'other',
      billingModel: 'served',
      provider: 'codex',
      latencyMs: null,
    }),
    event(4, { model: 'unknown', requestedModel: 'request-priced', billingModel: 'missing' }),
    event(5, {
      model: 'canonical',
      requestedModel: 'alias-fast',
      billingModel: 'missing',
      tokens: zeroTokens,
      ttftMs: 0,
    }),
    event(6, { billingModel: 'claude-fable-5-2' }),
    event(7, { billingModel: 'gpt-6.1-terra', provider: 'codex', failed: true }),
    event(8, { recordKind: RECORD_KIND.supplementary }),
    event(9, {
      model: 'unpriced',
      requestedModel: 'unpriced',
      billingModel: 'unpriced',
      usageFlags: 0,
      recordKind: 0,
    }),
  ];
  f.insert(rows);
  const fold = new UsageExporter((visit) => f.store.scanExporterEvents(visit));
  const models = {
    canonical: {
      ...rates,
      service_tiers: [{ ...rates, input: 10, names: ['priority'] }],
      context_tiers: [{ ...rates, input: 8, above_input_tokens: 900 }],
    },
    'alias-fast': { ...rates, context_tiers: [{ ...rates, input: 30, above_input_tokens: 1 }] },
    'request-priced': { ...rates, cache_read: null, cache_write: null },
    'claude-fable-5-2': rates,
    'gpt-6.1-terra': rates,
  };
  for (const b of [
    parseRateBook({ version: 1, models }),
    parseRateBook({
      version: 1,
      models: { ...models, served: { ...rates, input: 5 }, canonical: { ...rates, output: 9 } },
    }),
  ]) {
    fold.refresh(b);
    const snapshot = fold.snapshot(emptyAliases);
    for (const provider of [undefined, 'claude', 'codex']) {
      for (const outcome of ['all', 'success', 'failed'] as const) {
        const groups = snapshot.groups.filter(
          (g) =>
            (!provider || g.provider === provider) &&
            (outcome === 'all' || g.status === (outcome === 'failed' ? 'failed' : 'success'))
        );
        const total = (pick: (g: (typeof groups)[number]) => number) =>
          groups.reduce((sum, g) => sum + pick(g), 0);
        const analytics = queryAnalytics(f.db, query({ provider, outcome }), rateState(b)).summary;
        expect(total((g) => g.requests)).toBe(analytics.calls);
        expect(total((g) => (g.status === 'failed' ? g.requests : 0))).toBe(
          analytics.failure_calls
        );
        expect(total((g) => g.tokens.input)).toBe(analytics.input_tokens);
        expect(total((g) => g.tokens.output)).toBe(analytics.output_tokens);
        expect(total((g) => g.tokens.reasoning)).toBe(analytics.reasoning_tokens);
        expect(total((g) => g.cache.read)).toBe(analytics.cache_read_tokens);
        expect(total((g) => g.cache.write)).toBe(analytics.cache_creation_tokens);
        expect(total((g) => g.cost_usd ?? 0)).toBeCloseTo(analytics.cost.usd ?? 0, 12);
        const latencyCount = total((g) => g.latency_seconds_count);
        if (latencyCount)
          expect((total((g) => g.latency_seconds_sum) * 1000) / latencyCount).toBeCloseTo(
            analytics.average_latency_ms!,
            10
          );
      }
    }
  }
  // No -fast suffix inference and no generic cache-read fallback. Requested-only rates are valid.
  const requestOnly = fold.snapshot(emptyAliases).groups.find((g) => g.model === 'request-priced')!;
  expect(requestOnly.cost_usd).toBeCloseTo((100 * 2 + 200 * 4 + 50 * 2) / 1e6, 12);
});

test('store publishes only committed inserts, not duplicates or rolled-back imports', () => {
  const f = analyticsStore();
  cleanups.push(() => f.close());
  const fold = new UsageExporter((visit) => f.store.scanExporterEvents(visit));
  fold.refresh(book());
  f.store.onCommit = (events) => events.forEach((row) => fold.add(row));
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
  instrument.exec('DROP TRIGGER fail_cursor');
  f.store.importChunk([event(2)], 1);
  expect(fold.snapshot(emptyAliases).groups[0].requests).toBe(2);
  const restarted = new UsageExporter((visit) => f.store.scanExporterEvents(visit));
  restarted.refresh(book());
  expect(restarted.snapshot(emptyAliases)).toEqual(fold.snapshot(emptyAliases));
  expect(USAGE_MIGRATIONS).toHaveLength(1);
  expect(f.db.query('PRAGMA table_info(event_detail)').all()).not.toContainEqual(
    expect.objectContaining({ name: 'reported_input' })
  );
  expect(f.store.getMeta('exporter:cpamp:last_id')).toBeNull();
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
      rate_book_loaded: true,
      client_alias_error: false,
      client_aliases_loaded: true,
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
  fold.add(event(1));
  expect((await handler(request())).status).toBe(200);
});

test('worker distinguishes never-loaded configuration from last-good reload failures', async () => {
  const root = mkdtempSync('/dev/shm/prox-exporter-worker-');
  cleanups.push(() => rmSync(root, { recursive: true }));
  const path = join(root, 'usage.sqlite');
  const store = new UsageStore({ events: path, raw: null });
  const old = event(1);
  store.insert([{ event: old, raw: null }], 0);
  store.close();
  const ratePath = join(root, 'rates.json'),
    aliasPath = join(root, 'client-aliases.json');
  const writer = new UsageWriter();
  cleanups.push(() => writer.close());
  await writer.init({ events: path, raw: null }, [], Date.now(), undefined, {
    rateBookPath: ratePath,
    clientAliasesPath: aliasPath,
  });
  expect(await writer.exporterSnapshot()).toMatchObject({
    rate_book_loaded: false,
    client_aliases_loaded: false,
    rate_book_error: true,
    client_alias_error: true,
  });
  writeFileSync(ratePath, JSON.stringify(book()));
  expect(await writer.exporterSnapshot()).toMatchObject({
    rate_book_loaded: true,
    client_aliases_loaded: false,
  });
  writeFileSync(
    aliasPath,
    JSON.stringify({ client_alias: [{ api_key_hash: old.apiKeyHash, alias: 'New name' }] }),
    { mode: 0o600 }
  );
  const snapshot = await writer.exporterSnapshot();
  expect(snapshot).toMatchObject({
    rate_book_loaded: true,
    client_aliases_loaded: true,
    rate_book_error: false,
    client_alias_error: false,
  });
  expect(snapshot.groups[0]).toMatchObject({
    client: 'New name',
    tokens: { input: 950, output: 200, cached: 800 },
  });
  writeFileSync(ratePath, '{');
  writeFileSync(aliasPath, '{');
  utimesSync(ratePath, 100, 100);
  utimesSync(aliasPath, 100, 100);
  const retained = await writer.exporterSnapshot();
  expect(retained).toMatchObject({
    rate_book_loaded: true,
    client_aliases_loaded: true,
    rate_book_error: true,
    client_alias_error: true,
  });
  expect(retained.groups).toEqual(snapshot.groups);
});

test('endpoint label values equal the deployed exporter SQL choices on the shared fixture', async () => {
  const f = analyticsStore();
  cleanups.push(() => f.close());
  const source = createCpamp(join(f.directory, 'cpamp.sqlite'), 0);
  cleanups.push(() => source.db.close());
  source.db.exec('CREATE TABLE api_key_aliases(api_key_hash TEXT, alias TEXT)');
  for (const alias of labelFixture.client_alias)
    source.db
      .query('INSERT INTO api_key_aliases VALUES (?,?)')
      .run(alias.api_key_hash, alias.alias);
  labelFixture.events.forEach((row, index) => source.add(cpampRow(index + 1, row)));
  const reader = openUsageReader(join(f.directory, 'cpamp.sqlite'));
  cleanups.push(() => reader.close());
  await runCpampJob(f.store, reader, { mode: 'import', governor: fakeIo().governor });
  const old = source.db
    .query(
      `SELECT e.provider,
    COALESCE(NULLIF(e.requested_model,''),e.model) AS model,
    COALESCE(NULLIF(e.account_snapshot,''),e.auth_label_snapshot,e.auth_index) AS account,
    COALESCE(NULLIF(a.alias,''),CASE WHEN e.api_key_hash IS NULL OR e.api_key_hash='' THEN 'unknown'
      ELSE 'key ' || substr(e.api_key_hash,1,8) END) AS client
    FROM usage_events e LEFT JOIN api_key_aliases a ON a.api_key_hash=e.api_key_hash`
    )
    .all();
  const fold = new UsageExporter((visit) => f.store.scanExporterEvents(visit));
  fold.refresh(book());
  const keyFile = join(f.directory, 'key');
  writeFileSync(keyFile, 'synthetic-key');
  const handler = createUsageStatusHandler({
    keyFile,
    healthy: () => true,
    sources: () => [],
    writer: () => ({
      backlog: 0,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      rawBufferFailures: 0,
      gaps: 0,
    }),
    exporter: async () => ({
      ...fold.snapshot(new Map(labelFixture.client_alias.map((a) => [a.api_key_hash, a.alias]))),
      rate_book_loaded: true,
      client_aliases_loaded: true,
      rate_book_error: false,
      client_alias_error: false,
    }),
  });
  const response = await handler(
    new Request('http://127.0.0.1/v1/exporter', {
      headers: { Authorization: 'Bearer synthetic-key' },
    })
  );
  const data = await response.json();
  const labels = data.groups.map(
    ({
      provider,
      model,
      account,
      client,
    }: {
      provider: string;
      model: string;
      account: string;
      client: string;
    }) => ({ provider, model, account, client })
  );
  const sort = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();
  expect(sort(labels)).toEqual(sort(old));
  expect(sort(labels)).toEqual(sort(labelFixture.labels));
  expect(labels.map((row: { client: string }) => row.client).sort()).toEqual(
    ['Windows · SwerveStation', 'key bbbbbbbb', 'unknown'].sort()
  );
});
