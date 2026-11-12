import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareEvents,
  openParityReader,
  validateIntervals,
  type Interval,
} from '../scripts/usage-parity/events';
import { DUAL_RUN_START } from '../scripts/usage-parity/matrix';
import {
  CPAMP_EVENT_COLUMNS,
  cpampPreconditions,
  mapCpampRow,
  type CpampSourceRow,
} from '../server/usage/importCpamp';
import { UsageStore } from '../server/usage/store';
import type { NormalizedEvent } from '../server/usage/types';
import type { Difference } from '../scripts/usage-parity/compare';
import { createCpamp, cpampRow } from './fixtures/cpampUsage';
import { quietGate } from './helpers/usageParity';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const START = DUAL_RUN_START + 300_000;
function fixture(count = 1) {
  const root = mkdtempSync('/dev/shm/prox-parity-events-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cpamp = createCpamp(join(root, 'cpamp.sqlite'), 0);
  cleanups.push(() => cpamp.db.close());
  cpamp.db.exec('CREATE INDEX idx_usage_events_timestamp ON usage_events(timestamp_ms)');
  for (let i = 1; i <= count; i++) cpamp.add(cpampRow(i, { timestamp_ms: START + 1 }));
  const source = openParityReader(join(root, 'cpamp.sqlite'));
  cleanups.push(() => source.close());
  const store = new UsageStore({ events: join(root, 'prox.sqlite'), raw: null });
  cleanups.push(() => store.close());
  const target = openParityReader(join(root, 'prox.sqlite'));
  cleanups.push(() => target.close());
  const rows = source
    .query<CpampSourceRow, []>(`SELECT ${CPAMP_EVENT_COLUMNS} FROM usage_events`)
    .all();
  const events = rows.map((row) => mapCpampRow(row, cpampPreconditions(), new Set())!);
  const insert = (event: NormalizedEvent, ingest: 0 | 1 | 2 | 3 = 0) =>
    store.insert([{ event, raw: null }], ingest);
  const differences: Difference[] = [];
  const run = (outages: Interval[] = [], from = START, to = START + 300_000) =>
    compareEvents(source, target, from, to, quietGate(), (d) => differences.push(d), outages);
  return { root, cpamp, source, target, store, events, insert, differences, run };
}
describe('read-only event parity', () => {
  test('opens mode=ro/query_only handles and never writes to either event database', async () => {
    const f = fixture();
    f.insert(f.events[0]);
    for (const db of [f.source, f.target]) {
      expect(Object.values(db.query('PRAGMA query_only').get()!)).toEqual([1]);
      db.exec('PRAGMA query_only=0');
      expect(() => db.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow();
      db.exec('PRAGMA query_only=1');
    }
    const report = await f.run();
    expect(report).toMatchObject({ cpamp_rows: 1, prox_rows: 1, matched: 1, complete: true });
    expect(f.differences).toEqual([]);
  });
  test('forces the bounded timestamp index and keyset-pages a tied timestamp across 1000 rows', async () => {
    const f = fixture(1001);
    f.events.forEach((e) => f.insert(e));
    const report = await f.run();
    expect(report.matched).toBe(1001);
    expect(f.differences).toEqual([]);
    f.cpamp.db.exec('DROP INDEX idx_usage_events_timestamp');
    await expect(f.run()).rejects.toThrow('idx_usage_events_timestamp');
  });
  test('every required event field is checked, including all seven token fields', async () => {
    const scalarChanges: Partial<NormalizedEvent>[] = [
      { provider: 'different' },
      { account: 'different' },
      { accountLabel: 'different' },
      { apiKeyHash: 'b'.repeat(64) },
      { model: 'different' },
      { requestedModel: 'different' },
      { billingModel: 'different' },
      { tier: 'different' },
      { failed: false },
      { statusCode: 429 },
      { latencyMs: 12345 },
      { ttftMs: 12345 },
      { usageFlags: 0 },
      { recordKind: 2 },
      { tsMs: START + 2 },
    ];
    for (const change of scalarChanges) {
      const f = fixture();
      f.insert({ ...f.events[0], ...change });
      await f.run();
      expect(f.differences.some((d) => d.class === 'unexplained')).toBe(true);
    }
    for (const field of [
      'inputTotal',
      'inputUncached',
      'cacheRead',
      'cacheWrite',
      'outputTotal',
      'reasoning',
      'total',
    ] as const) {
      const f = fixture();
      f.insert({ ...f.events[0], tokens: { ...f.events[0].tokens, [field]: 99999 } });
      await f.run();
      expect(f.differences.some((d) => d.class === 'unexplained')).toBe(true);
    }
  });
  test('checks CPAMP-to-Prox and all subscribed Prox events in the reverse direction', async () => {
    const f = fixture(2);
    f.insert(f.events[0]);
    f.insert({ ...f.events[0], executionId: 'target-only-subscribed' });
    f.insert({ ...f.events[0], executionId: 'target-only-imported' }, 2);
    const report = await f.run();
    expect(report.matched).toBe(1);
    expect(report.excluded_imported_or_replayed).toBe(1);
    expect(f.differences).toHaveLength(2);
    expect(f.differences.every((d) => d.class === 'unexplained')).toBe(true);
  });
  test('drained exceptions require a matching instance/time and documented CPAMP outage', async () => {
    const f = fixture();
    f.insert(f.events[0]);
    const drained = { ...f.events[0], executionId: 'drained-extra' };
    f.insert(drained, 1);
    await f.run();
    expect(f.differences[0].class).toBe('unexplained');
    f.differences.length = 0;
    const outage = {
      from_ms: START,
      to_ms: START + 100,
      instance: drained.instance!,
      reason: 'synthetic CPAMP downtime',
    };
    await f.run([outage]);
    expect(f.differences[0]).toMatchObject({
      class: 'drained-during-cpamp-outage',
      cpamp: { interval: outage },
    });
    f.differences.length = 0;
    await f.run([{ ...outage, instance: 'other-instance' }]);
    expect(f.differences[0].class).toBe('unexplained');
  });
  test('ingest gaps explain missing events only in the same instance and interval', async () => {
    const f = fixture();
    f.store.recordGap({
      instance: f.events[0].instance!,
      fromMs: START,
      toMs: START + 100,
      reason: 'subscription-dropped',
    });
    const report = await f.run();
    expect(report.gaps).toHaveLength(1);
    expect(f.differences[0].class).toBe('ingest-gap');
    const other = fixture();
    other.store.recordGap({
      instance: 'unrelated',
      fromMs: START,
      toMs: START + 100,
      reason: 'subscription-dropped',
    });
    await other.run();
    expect(other.differences[0].class).toBe('unexplained');
  });
  test('does not scan events before the dual-run start and rejects ungrounded intervals', async () => {
    const f = fixture();
    expect((await f.run([], DUAL_RUN_START - 86400000, DUAL_RUN_START)).cpamp_rows).toBe(0);
    expect(() =>
      validateIntervals([{ from_ms: 1, to_ms: 0, instance: 'x', reason: 'bad' }])
    ).toThrow();
    expect(() =>
      validateIntervals([{ from_ms: 0, to_ms: 1, instance: 'x', reason: '' }])
    ).toThrow();
  });
});

test('CPAMP persisted tier wins over raw tier even when Prox agrees with the raw payload', async () => {
  const f = fixture();
  expect(f.events[0].tier).toBe('standard');
  f.cpamp.db.exec("UPDATE usage_events SET service_tier='priority'");
  f.insert(f.events[0]);
  const report = await f.run();
  expect(report.matched).toBe(0);
  expect(f.differences).toContainEqual({
    class: 'unexplained',
    path: `events.${f.events[0].executionId}.tier`,
    cpamp: 'priority',
    prox: 'standard',
  });
});
test('persisted values are not trimmed, recased, clamped or replaced by the Prox mapper', async () => {
  const cases: [string, string | number, Partial<NormalizedEvent>, string, unknown][] = [
    ['provider', '', { provider: 'unknown' }, 'provider', ''],
    ['account_snapshot', ' snapshot@example.test ', {}, 'account', ' snapshot@example.test '],
    ['auth_label_snapshot', ' Synthetic account ', {}, 'account_label', ' Synthetic account '],
    ['api_key_hash', 'A'.repeat(64), {}, 'api_key_hash', 'A'.repeat(64)],
    ['requested_model', ' client-claude ', {}, 'requested_model', ' client-claude '],
    ['resolved_model', ' claude-test-4 ', {}, 'billing_model', ' claude-test-4 '],
    ['failed', 2, { failed: false }, 'failed', 2],
    ['fail_status_code', 0, { statusCode: null }, 'status_code', 0],
    ['latency_ms', 0, { latencyMs: null }, 'latency_ms', 0],
    ['ttft_ms', -1, { ttftMs: null }, 'ttft_ms', -1],
  ];
  for (const [column, persisted, overrides, field, expected] of cases) {
    const f = fixture();
    f.cpamp.db.query(`UPDATE usage_events SET ${column}=?`).run(persisted);
    f.insert({ ...f.events[0], ...overrides });
    const report = await f.run();
    expect(report.matched).toBe(0);
    expect(f.differences.find((d) => d.path.endsWith(`.${field}`))).toMatchObject({
      class: 'unexplained',
      cpamp: expected,
    });
  }
});
test('all seven persisted counters and timestamp stay independent of the raw envelope', async () => {
  for (const [column, field] of [
    ['normalized_total_input_tokens', 'input_total'],
    ['normalized_uncached_input_tokens', 'input_uncached'],
    ['normalized_cache_read_tokens', 'cache_read'],
    ['normalized_cache_creation_tokens', 'cache_write'],
    ['output_tokens', 'output_total'],
    ['reasoning_tokens', 'reasoning'],
    ['total_tokens', 'total'],
    ['timestamp_ms', 'ts_ms'],
  ]) {
    const f = fixture();
    f.insert(f.events[0]);
    f.cpamp.db.exec(`UPDATE usage_events SET ${column}=${column}+1`);
    expect((await f.run()).matched).toBe(0);
    expect(f.differences.find((d) => d.path.endsWith(`.${field}`))?.class).toBe('unexplained');
  }
});
test('metadata-only fields follow CPAMP parsing, not the Prox normalizer', async () => {
  const f = fixture();
  f.insert(f.events[0]);
  f.cpamp.db.exec(
    `UPDATE usage_events SET raw_json=json_set(raw_json,'$.record_kind',' execution ')`
  );
  expect((await f.run()).matched).toBe(0);
  expect(f.differences).toContainEqual({
    class: 'unexplained',
    path: `events.${f.events[0].executionId}.record_kind`,
    cpamp: 0,
    prox: 1,
  });
});

test('CPAMP account fallback preserves an empty persisted label instead of substituting auth_index', async () => {
  const f = fixture();
  f.cpamp.db.exec("UPDATE usage_events SET account_snapshot=NULL, auth_label_snapshot=''");
  f.insert({ ...f.events[0], account: '3', accountLabel: null });
  expect((await f.run()).matched).toBe(0);
  expect(f.differences.find((d) => d.path.endsWith('.account'))).toMatchObject({
    cpamp: '',
    prox: '3',
    class: 'unexplained',
  });
});

test('independent CPAMP flag decoding keeps Go whitespace semantics rather than JS trim', async () => {
  const f = fixture();
  f.insert(f.events[0]);
  f.cpamp.db.exec(
    "UPDATE usage_events SET raw_json=json_set(raw_json,'$.token_breakdown.quality',char(65279)||'complete')"
  );
  expect((await f.run()).matched).toBe(0);
  expect(f.differences.find((d) => d.path.endsWith('.usage_flags'))).toMatchObject({
    class: 'unexplained',
    cpamp: f.events[0].usageFlags & ~128,
    prox: f.events[0].usageFlags,
  });
});
