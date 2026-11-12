import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRateBookLoader, parseRateBook, priceRevision } from '../server/usage/rates';
import { buildRateInventory } from '../server/usage/pricing';
import { exportCpampRates } from '../scripts/usage-export-cpamp-rates';

const base = { input: 2, output: 4, cache_read: 0.5, cache_write: null };
const raw = { version: 1, models: { paid: base } };
const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'prox-rates-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('canonical revision is SHA-256, stable across key order and provenance, changes for null/zero and tiers', () => {
  const book = parseRateBook(raw);
  const canonical =
    '{"models":{"paid":{"cache_read":0.5,"cache_write":null,"context_tiers":[],"input":2,"output":4,"service_tiers":[]}},"version":1}';
  expect(priceRevision(book)).toBe(createHash('sha256').update(canonical).digest('hex'));
  const reordered = JSON.parse(
    '{"models":{"paid":{"output":4,"cache_write":null,"input":2,"cache_read":0.5,"source":"other","updated_at_ms":100}},"version":1}'
  );
  expect(priceRevision(parseRateBook(reordered))).toBe(priceRevision(book));
  for (const changed of [
    { ...base, input: 3 },
    { ...base, cache_write: 0 },
    { ...base, context_tiers: [{ ...base, above_input_tokens: 100 }] },
    { ...base, service_tiers: [{ ...base, names: ['fast'] }] },
  ])
    expect(priceRevision(parseRateBook({ version: 1, models: { paid: changed } }))).not.toBe(
      priceRevision(book)
    );
  const tierA = {
    ...base,
    context_tiers: [{ ...base, above_input_tokens: 100 }],
    service_tiers: [{ ...base, names: ['fast', 'priority'] }],
  };
  const reverseKeys = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reverseKeys)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reverseKeys(item)])
          )
        : value;
  expect(priceRevision(parseRateBook({ version: 1, models: { paid: tierA } }))).toBe(
    priceRevision(parseRateBook(reverseKeys({ version: 1, models: { paid: tierA } })))
  );
  const a = parseRateBook({ version: 1, models: { paid: base, source: base } });
  const b = parseRateBook({ models: { source: base, paid: base }, version: 1 });
  expect(priceRevision(a)).toBe(priceRevision(b)); // model named source must not be discarded
});

test('loader injects clock and file IO, reloads mtime changes and preserves immutable last good on errors', () => {
  let content = JSON.stringify(raw),
    modified = 1,
    now = 100,
    reads = 0;
  const loader = createRateBookLoader('unused', {
    now: () => now,
    mtime: () => modified,
    read: () => {
      reads++;
      return content;
    },
  });
  const first = loader.load();
  expect(first.loaded_at_ms).toBe(100);
  expect(first.error).toBeNull();
  now++;
  expect(loader.load().book).toBe(first.book);
  expect(reads).toBe(1);
  content = '{broken';
  modified++;
  const invalid = loader.load();
  expect(invalid.error).toBeString();
  expect(invalid.book).toBe(first.book);
  expect(invalid.price_revision).toBe(first.price_revision);
  expect(invalid.loaded_at_ms).toBe(100);
  content = JSON.stringify({ version: 1, models: { paid: { ...base, input: 3 } } });
  const second = loader.load(); // failed IO/parse attempts are retried, including same mtime
  expect(second.error).toBeNull();
  expect(second.book?.models.paid.input).toBe(3);
  expect(second.price_revision).not.toBe(first.price_revision);
  expect(first.book?.models.paid.input).toBe(2);
  expect(Object.isFrozen(second.book?.models.paid)).toBe(true);
});

test('real file reload, invalid schema and deletion preserve last good; missing startup is visible', () => {
  const path = join(directory(), 'rates.json');
  const loader = createRateBookLoader(path);
  expect(loader.load()).toMatchObject({ book: null, price_revision: null, loaded_at_ms: null });
  expect(loader.load().error).toBeString();
  writeFileSync(path, JSON.stringify(raw));
  const first = loader.load();
  expect(first.book?.models.paid.input).toBe(2);
  writeFileSync(path, JSON.stringify({ version: 1, models: { paid: { ...base, input: 9 } } }));
  utimesSync(path, new Date(1000), new Date(1000));
  expect(loader.load().book?.models.paid.input).toBe(9);
  writeFileSync(path, JSON.stringify({ ...raw, version: 2 }));
  utimesSync(path, new Date(2000), new Date(2000));
  expect(loader.load().error).toContain('version');
  expect(loader.load().book?.models.paid.input).toBe(9);
  rmSync(path);
  expect(loader.load().book?.models.paid.input).toBe(9);
  expect(loader.load().error).toBeString();
});

test('validation rejects malformed prices, duplicate bands/names and unknown schema fields', () => {
  for (const input of [
    null,
    [],
    { ...raw, version: 2 },
    { ...raw, extra: true },
    ...[-1, Infinity, '2', undefined].map((input) => ({
      version: 1,
      models: { paid: { ...base, input } },
    })),
    { version: 1, models: { ' ': base } },
    {
      version: 1,
      models: { paid: { ...base, context_tiers: [{ ...base, above_input_tokens: 0 }] } },
    },
    {
      version: 1,
      models: {
        paid: {
          ...base,
          context_tiers: [
            { ...base, above_input_tokens: 10 },
            { ...base, above_input_tokens: 10 },
          ],
        },
      },
    },
    {
      version: 1,
      models: {
        paid: {
          ...base,
          service_tiers: [
            { ...base, names: ['FAST'] },
            { ...base, names: ['fast'] },
          ],
        },
      },
    },
    { version: 1, models: { paid: { ...base, service_tiers: [{ ...base, names: [] }] } } },
  ])
    expect(() => parseRateBook(input)).toThrow();
  const prototype = parseRateBook(
    JSON.parse(
      '{"version":1,"models":{"__proto__":{"input":0,"output":0,"cache_read":null,"cache_write":null}}}'
    )
  );
  expect(prototype.models.__proto__.input).toBe(0);
});

test('example validates and has explicit pending D5 models', () => {
  const book = parseRateBook(JSON.parse(readFileSync('deploy/usage-rates.example.json', 'utf8')));
  expect(book.models['gpt-6.1-terra']).toMatchObject({
    ...base,
    input: null,
    output: null,
    cache_read: null,
    source: 'pending D5',
  });
});

test('read-only exporter maps only configured prices, context and service names, and hashed aliases', () => {
  const path = join(directory(), 'source #1.sqlite');
  const db = new Database(path);
  const columns =
    'model TEXT, prompt_per_1m REAL, completion_per_1m REAL, cache_read_per_1m REAL, cache_creation_per_1m REAL, prompt_configured INTEGER, completion_configured INTEGER, cache_read_configured INTEGER, cache_creation_configured INTEGER';
  db.exec(`CREATE TABLE model_prices (${columns}, source TEXT, updated_at_ms INTEGER)`);
  db.exec(`CREATE TABLE model_price_context_tiers (${columns}, threshold_tokens INTEGER)`);
  db.exec(`CREATE TABLE model_price_service_tiers (${columns}, mode TEXT, service_tier TEXT)`);
  db.exec('CREATE TABLE api_key_aliases (api_key_hash TEXT, alias TEXT)');
  db.exec("INSERT INTO model_prices VALUES ('paid',2,4,0,0,1,1,0,1,'models.dev',100)");
  db.exec("INSERT INTO model_price_context_tiers VALUES ('paid',4,0,0,0,1,0,0,0,100)");
  db.exec(
    "INSERT INTO model_price_service_tiers VALUES ('paid',0,8,0,0,0,1,0,0,'fast','priority')"
  );
  db.exec("INSERT INTO api_key_aliases VALUES ('synthetic-sha256','Synthetic client')");
  db.close();
  const before = readFileSync(path);
  const exported = exportCpampRates(path);
  expect(readFileSync(path)).toEqual(before);
  expect(exported.book.models.paid).toMatchObject({
    input: 2,
    output: 4,
    cache_read: null,
    cache_write: 0,
    service_tiers: [
      { input: null, output: 8, cache_read: null, cache_write: null, names: ['fast', 'priority'] },
    ],
  });
  expect(exported.client_alias).toEqual([
    { api_key_hash: 'synthetic-sha256', alias: 'Synthetic client' },
  ]);
  const inventory = buildRateInventory([], [{ provider: 'synthetic', id: 'paid' }], exported.book);
  expect(inventory[0]).toMatchObject({
    context_tiers: [{ above_input_tokens: 100, input_per_million: 4, output_per_million: 4 }],
    service_tiers: [{ name: 'priority', input_per_million: 2, output_per_million: 8 }],
  });
});
