import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCpampJob } from '../server/usage/importCpamp';
import { normalizeUsagePayload } from '../server/usage/normalize';
import { openUsageReader, UsageStore } from '../server/usage/store';
import { INGEST } from '../server/usage/types';
import {
  cpampRow,
  createCpamp,
  createCpampRollups,
  ROLLUP_HOUR,
  PARENT_SESSION,
  V8_SESSION,
} from './fixtures/cpampUsage';
import { usagePayloadNumber } from './fixtures/usagePayloads';
import { fakeIo } from './helpers/usageIo';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function fixture(count = 3) {
  const root = mkdtempSync('/dev/shm/prox-import-test-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'cpamp.sqlite');
  const writableSource = createCpamp(sourcePath, count);
  cleanups.push(() => writableSource.db.close());
  const source = openUsageReader(sourcePath);
  cleanups.push(() => source.close());
  const path = join(root, 'usage.sqlite');
  let store = new UsageStore({ events: path, raw: null });
  cleanups.push(() => store.close());
  const reader = openUsageReader(path);
  cleanups.push(() => reader.close());
  return {
    source,
    writableSource,
    reader,
    path,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new UsageStore({ events: path, raw: null });
    },
  };
}
function item(index: number, overrides: Record<string, unknown> = {}) {
  const result = normalizeUsagePayload(JSON.stringify(usagePayloadNumber(index, overrides)));
  if (result.kind !== 'event') throw new Error('invalid fixture');
  return { event: result.event, raw: null };
}
const scalar = (db: Database, sql: string) => Object.values(db.query(sql).get() as object)[0];

describe('CPAMP migration jobs', () => {
  test('copies normalized columns, metadata, session trees and auth indexes; hourly sums are exact', async () => {
    const f = fixture();
    const io = fakeIo();
    const report = await runCpampJob(f.store, f.source, { mode: 'import', governor: io.governor });
    expect(report).toMatchObject({
      read: 3,
      inserted: 3,
      lastId: 3,
      chunks: 1,
      conflicts: 0,
      preconditions: { missingExecutionId: 0, invalidTokens: 0, invalidBreakdownIdentity: 0 },
      verification: { read: 3, missing: 0, different: 0, exact: true },
    });
    expect(report.verification.hours).toHaveLength(3);
    const first = report.verification.hours[0];
    expect(first.source).toEqual(first.target);
    expect(first.source).toMatchObject({
      rows: '1',
      failed: '1',
      input_total: '950',
      input_uncached: '100',
      cache_read: '800',
      cache_write: '50',
      output_total: '200',
      reasoning: '60',
      total: '1150',
      latency_ms: '1503',
      ttft_sum: '0',
      ttft_count: '0',
    });
    expect(
      f.reader
        .query(
          `SELECT s.uuid, s.derived, p.uuid AS parent FROM session s LEFT JOIN session p ON p.id=s.parent_id ORDER BY s.derived`
        )
        .all()
    ).toEqual([
      { uuid: PARENT_SESSION, derived: 0, parent: null },
      { uuid: V8_SESSION, derived: 1, parent: PARENT_SESSION },
    ]);
    expect(
      f.reader
        .query(
          `SELECT a.value AS auth_index, c.value AS account, e.ingest FROM events e JOIN dim a ON a.id=e.auth_index_id JOIN dim c ON c.id=e.account_id`
        )
        .all()
    ).toEqual(
      Array(3).fill({ auth_index: '3', account: 'snapshot@example.test', ingest: INGEST.imported })
    );
    expect(scalar(f.reader, `SELECT count(*) FROM dim WHERE kind='session'`)).toBe(0);
    expect(io.governor.counters.bytesRead).toBeGreaterThan(0);
    expect(io.governor.counters.bytesWritten).toBeGreaterThan(0);
    expect(io.clock.now()).toBeGreaterThan(0);
  });

  test('resumes after a kill at each chunk boundary and verifies the whole prefix', async () => {
    for (const boundary of [1000, 2000, 3000, 3001]) {
      const f = fixture(3001);
      await expect(
        runCpampJob(f.store, f.source, {
          mode: 'import',
          governor: fakeIo().governor,
          betweenChunks: async () => {
            if (f.store.getMeta('import:cpamp:last_id') === String(boundary))
              throw new Error('synthetic kill');
          },
        })
      ).rejects.toThrow('synthetic kill');
      expect(scalar(f.reader, 'SELECT count(*) FROM events')).toBe(boundary);
      f.reopen();
      const resumed = await runCpampJob(f.store, f.source, {
        mode: 'import',
        governor: fakeIo().governor,
      });
      expect(resumed.inserted).toBe(3001 - boundary);
      expect(resumed.verification).toMatchObject({ read: 3001, exact: true });
      const before = f.reader.serialize();
      const rerun = await runCpampJob(f.store, f.source, {
        mode: 'import',
        governor: fakeIo().governor,
      });
      expect(rerun.inserted).toBe(0);
      expect(rerun.verification.exact).toBe(true);
      expect(f.reader.serialize()).toEqual(before);
    }
  });

  test('cursor failure rolls back rows, dimensions, sessions and sequence numbers', async () => {
    const f = fixture();
    const instrument = new Database(f.path);
    cleanups.push(() => instrument.close());
    instrument.exec(
      `CREATE TRIGGER fail_cursor BEFORE INSERT ON meta WHEN NEW.key='import:cpamp:last_id' BEGIN SELECT RAISE(ABORT, 'kill inside commit'); END`
    );
    await expect(
      runCpampJob(f.store, f.source, { mode: 'import', governor: fakeIo().governor })
    ).rejects.toThrow('kill inside commit');
    expect(scalar(f.reader, 'SELECT count(*) FROM events')).toBe(0);
    expect(scalar(f.reader, 'SELECT count(*) FROM dim')).toBe(0);
    expect(scalar(f.reader, 'SELECT count(*) FROM session')).toBe(0);
    expect(f.store.getMeta('import:cpamp:last_id')).toBeNull();
    instrument.exec('DROP TRIGGER fail_cursor');
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(true);
    expect(scalar(f.reader, 'SELECT min(seq) FROM events')).toBe(1);
  });

  test('live conflicts are recorded once, live rows stay, verify writes nothing and detects drift', async () => {
    const f = fixture(1);
    const live = item(1, { timestamp: '2026-11-01T01:00:00Z', latency_ms: 999 });
    f.store.insert([live], INGEST.subscribed);
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report).toMatchObject({
      inserted: 0,
      duplicates: 1,
      verification: { exact: false, different: 1 },
    });
    expect(report.conflicts).toBeGreaterThan(0);
    expect(
      f.reader
        .query(`SELECT field, live, imported FROM import_conflicts WHERE field='latency_ms'`)
        .get()
    ).toEqual({ field: 'latency_ms', live: '999', imported: '1501' });
    expect(scalar(f.reader, 'SELECT latency_ms FROM events')).toBe(999);
    const before = f.reader.serialize();
    const verified = await runCpampJob(f.store, f.source, {
      mode: 'verify',
      governor: fakeIo().governor,
    });
    expect(verified.verification.exact).toBe(false);
    expect(verified.verification.hours[0].equal).toBe(false);
    expect(f.reader.serialize()).toEqual(before);
    // Restart from 0 to exercise conflict idempotence even after losing a saved cursor.
    f.store.setMeta('import:cpamp:last_id', '0');
    expect(
      (await runCpampJob(f.store, f.source, { mode: 'reconcile', governor: fakeIo().governor }))
        .conflicts
    ).toBe(0);
    expect(scalar(f.reader, 'SELECT count(*) FROM import_conflicts')).toBe(report.conflicts);
  });

  test('reconcile imports new IDs, missing rows fail verification, and unrelated live rows are excluded', async () => {
    const f = fixture(1);
    await runCpampJob(f.store, f.source, { mode: 'import', governor: fakeIo().governor });
    f.writableSource.add(cpampRow(2));
    const missing = await runCpampJob(f.store, f.source, {
      mode: 'verify',
      governor: fakeIo().governor,
    });
    expect(missing.verification).toMatchObject({ missing: 1, exact: false });
    f.store.insert([item(99)], INGEST.subscribed);
    const report = await runCpampJob(f.store, f.source, {
      mode: 'reconcile',
      governor: fakeIo().governor,
    });
    expect(report).toMatchObject({
      inserted: 1,
      lastId: 2,
      verification: { read: 2, exact: true },
    });
    expect(scalar(f.reader, 'SELECT count(*) FROM events')).toBe(3);
  });

  test('independently detects target-only imported rows, while excluding subscribed and drained rows', async () => {
    const f = fixture(1);
    await runCpampJob(f.store, f.source, { mode: 'import', governor: fakeIo().governor });
    f.store.insert([item(90), item(91)], INGEST.subscribed);
    f.store.insert([item(92)], INGEST.drained);
    let verified = await runCpampJob(f.store, f.source, {
      mode: 'verify',
      governor: fakeIo().governor,
    });
    expect(verified.verification.exact).toBe(true);
    // Exercise the reported repro and an extra imported hour outside the source timestamps.
    f.store.insert([item(93, { timestamp: '2026-11-01T01:00:00Z' }), item(94)], INGEST.imported);
    const before = f.reader.serialize();
    verified = await runCpampJob(f.store, f.source, {
      mode: 'verify',
      governor: fakeIo().governor,
    });
    expect(verified.verification).toMatchObject({ exact: false, targetOnlyImported: 2 });
    const hour = verified.verification.hours.find((h) => h.hourMs === Date.UTC(2026, 10, 1, 1))!;
    expect(hour.source.rows).toBe('1');
    expect(hour.target.rows).toBe('2');
    expect(hour.equal).toBe(false);
    expect(f.reader.serialize()).toEqual(before);
  });

  test('limited verification counts only verified identities after a full or resumed import', async () => {
    const f = fixture(0);
    for (const id of [1, 2]) f.writableSource.add(cpampRow(id, { timestamp_ms: ROLLUP_HOUR }));
    const full = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(full.verification.exact).toBe(true);
    const before = f.reader.serialize();
    const limited = await runCpampJob(f.store, f.source, {
      mode: 'verify',
      maxRows: 1,
      governor: fakeIo().governor,
    });
    expect(limited.verification).toMatchObject({ read: 1, targetOnlyImported: 0, exact: true });
    expect(limited.verification.hours[0]).toMatchObject({
      source: { rows: '1' },
      target: { rows: '1' },
      equal: true,
    });
    expect(f.reader.serialize()).toEqual(before);
    f.writableSource.add(cpampRow(3, { timestamp_ms: ROLLUP_HOUR }));
    const resumed = await runCpampJob(f.store, f.source, {
      mode: 'import',
      maxRows: 1,
      governor: fakeIo().governor,
    });
    expect(resumed).toMatchObject({
      inserted: 1,
      lastId: 3,
      verification: { read: 1, targetOnlyImported: 0, exact: true },
    });
    expect(resumed.verification.hours[0]).toMatchObject({
      source: { rows: '1' },
      target: { rows: '1' },
      equal: true,
    });
  });

  test('cross-checks active CPAMP rollup calls and token sums across every provider/outcome group', async () => {
    const f = fixture(0);
    for (const id of [1, 2]) f.writableSource.add(cpampRow(id, { timestamp_ms: ROLLUP_HOUR }));
    const add = createCpampRollups(f.writableSource.db, { coverage_event_id: 2 });
    add({ cache_read_tokens: 500, cached_tokens: 300 });
    add({ failed: 0, provider: 'codex', cache_read_tokens: 500, cached_tokens: 300 });
    add({ structure_revision: 'stale-revision', calls: 999, total_tokens: 999 });
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(true);
    const rolls = report.verification.rollups;
    expect(rolls).toMatchObject({ available: true, complete: true, mismatches: [], uncovered: [] });
    expect(rolls.hours).toHaveLength(1);
    expect(rolls.hours[0].cpamp).toEqual({
      rows: '2',
      input_total: '1900',
      output_total: '400',
      reasoning: '120',
      cache_read: '1600',
      cache_write: '100',
      total: '2300',
    });
    expect(rolls.hours[0].cpamp).toEqual(rolls.hours[0].prox);
    const before = f.reader.serialize();
    await runCpampJob(f.store, f.source, { mode: 'verify', governor: fakeIo().governor });
    expect(f.reader.serialize()).toEqual(before);
  });

  test('rollup mismatches fail exact even when the event self-check matches', async () => {
    const f = fixture(1);
    createCpampRollups(f.writableSource.db)({ total_tokens: 1151 });
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.hours.every((hour) => hour.equal)).toBe(true);
    expect(report.verification.exact).toBe(false);
    expect(report.verification.rollups).toMatchObject({ complete: true, uncovered: [] });
    expect(report.verification.rollups.mismatches[0]).toMatchObject({
      hourMs: ROLLUP_HOUR,
      cpamp: { total: '1151' },
      prox: { total: '1150' },
      equal: false,
    });
  });

  test('reports lagging hours separately using event IDs, including late events in older hours', async () => {
    const f = fixture(0);
    f.writableSource.add(cpampRow(1, { timestamp_ms: ROLLUP_HOUR }));
    f.writableSource.add(cpampRow(2, { timestamp_ms: ROLLUP_HOUR + 3_600_000 }));
    f.writableSource.add(cpampRow(3, { timestamp_ms: ROLLUP_HOUR }));
    const add = createCpampRollups(f.writableSource.db, {
      status: 'catching_up',
      coverage_event_id: 2,
      max_bucket_ms: ROLLUP_HOUR + 3_600_000,
    });
    add();
    add({ bucket_ms: ROLLUP_HOUR + 3_600_000, failed: 0 });
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(true);
    expect(report.verification.rollups).toMatchObject({
      complete: false,
      mismatches: [],
      uncovered: [{ hourMs: ROLLUP_HOUR, reason: 'rollup-behind-hour' }],
    });
    expect(report.verification.rollups.hours.map((hour) => hour.hourMs)).toEqual([
      ROLLUP_HOUR + 3_600_000,
    ]);
  });

  // CPAMP keeps ingesting during the dual run: after this job captures its source maximum, a
  // newer event lands in the second hour and CPAMP's global rollup marker moves past it.
  function liveIngestFixture(overrides: { totalTokens?: number } = {}) {
    const f = fixture(0);
    const hour = (offset: number) => ROLLUP_HOUR + offset * 3_600_000;
    for (const id of [1, 2, 3]) f.writableSource.add(cpampRow(id, { timestamp_ms: hour(id - 1) }));
    const add = createCpampRollups(f.writableSource.db, {
      coverage_event_id: 3,
      max_bucket_ms: hour(2),
    });
    add({ bucket_ms: hour(0), total_tokens: overrides.totalTokens ?? 1150 });
    add({ bucket_ms: hour(1), calls: 2, total_tokens: 2300 });
    add({ bucket_ms: hour(2) });
    let ingested = false;
    const onProgress = (progress: { phase: string }) => {
      if (progress.phase !== 'verify' || ingested) return;
      ingested = true;
      f.writableSource.add(cpampRow(4, { timestamp_ms: hour(1) }));
      f.writableSource.db.exec('UPDATE usage_pricing_rollup_state SET coverage_event_id = 4');
    };
    return { f, hour, onProgress };
  }

  test('compares closed hours while CPAMP ingests; only the hour with newer events is uncovered', async () => {
    const { f, hour, onProgress } = liveIngestFixture();
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
      onProgress,
    });
    expect(report.verification.exact).toBe(true);
    expect(report.verification.rollups).toMatchObject({
      complete: false,
      mismatches: [],
      uncovered: [{ hourMs: hour(1), reason: 'hour-has-unverified-events' }],
    });
    expect(report.verification.rollups.hours.map((row) => row.hourMs)).toEqual([hour(0), hour(2)]);
  });

  test('a real difference in a compared hour is still a mismatch while CPAMP ingests', async () => {
    const { f, hour, onProgress } = liveIngestFixture({ totalTokens: 1151 });
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
      onProgress,
    });
    expect(report.verification.exact).toBe(false);
    expect(report.verification.rollups.uncovered).toEqual([
      { hourMs: hour(1), reason: 'hour-has-unverified-events' },
    ]);
    expect(report.verification.rollups.mismatches).toHaveLength(1);
    expect(report.verification.rollups.mismatches[0]).toMatchObject({
      hourMs: hour(0),
      cpamp: { total: '1151' },
      prox: { total: '1150' },
    });
  });

  test('a marker ahead of the verified range still compares an hour with no newer events', async () => {
    const f = fixture(1);
    createCpampRollups(f.writableSource.db, { coverage_event_id: 2 })();
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.rollups).toMatchObject({
      complete: true,
      mismatches: [],
      uncovered: [],
    });
    expect(report.verification.rollups.hours).toHaveLength(1);
  });

  test('checks rollup-only hours missing from both event stores', async () => {
    const f = fixture(1);
    const add = createCpampRollups(f.writableSource.db, { max_bucket_ms: ROLLUP_HOUR + 3_600_000 });
    add();
    add({ bucket_ms: ROLLUP_HOUR + 3_600_000 });
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(false);
    expect(report.verification.rollups.mismatches[0]).toMatchObject({
      hourMs: ROLLUP_HOUR + 3_600_000,
      cpamp: { rows: '1' },
      prox: { rows: '0' },
    });
  });

  test.each([
    [{ status: 'rebuilding' }, {}, 'rollup-not-ready'],
    [{ schema_version: 2 }, {}, 'rollup-state-unavailable'],
    [{ min_bucket_ms: ROLLUP_HOUR + 3_600_000 }, {}, 'outside-rollup-range'],
    [{}, { nowMs: ROLLUP_HOUR + 1000 }, 'open-hour'],
    [{}, { maxRows: 1 }, 'limited-source-pass'],
  ] as const)(
    'reports an uncovered hour without claiming a mismatch (%s)',
    async (state, options, reason) => {
      const f = fixture(1);
      createCpampRollups(f.writableSource.db, state)();
      const report = await runCpampJob(f.store, f.source, {
        mode: 'import',
        governor: fakeIo().governor,
        ...options,
      });
      expect(report.verification.exact).toBe(true);
      expect(report.verification.rollups).toMatchObject({
        complete: false,
        hours: [],
        mismatches: [],
        uncovered: [{ hourMs: ROLLUP_HOUR, reason }],
      });
    }
  );

  test('reports archived hours as uncovered because rollups can include deleted raw events', async () => {
    const f = fixture(1);
    createCpampRollups(f.writableSource.db)();
    f.writableSource.db
      .exec(`CREATE TABLE usage_archive_event_refs (timestamp_ms INTEGER, raw_deleted_at_ms INTEGER);
      CREATE INDEX archive_time ON usage_archive_event_refs(timestamp_ms, raw_deleted_at_ms)`);
    f.writableSource.db
      .query('INSERT INTO usage_archive_event_refs VALUES (?, ?)')
      .run(ROLLUP_HOUR, ROLLUP_HOUR + 3_600_000);
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.rollups).toMatchObject({
      complete: false,
      mismatches: [],
      uncovered: [{ hourMs: ROLLUP_HOUR, reason: 'archived-source-hour' }],
    });
  });

  test('counts per-row preconditions without inventing missing identities or canonical tokens', async () => {
    const f = fixture(0);
    f.writableSource.add(cpampRow(1, { raw_json: '{}' }));
    f.writableSource.add(cpampRow(2, { raw_json: 'broken' }));
    f.writableSource.add(cpampRow(3, { timestamp_ms: null }));
    f.writableSource.add(cpampRow(4, { normalized_total_input_tokens: -1 }));
    f.writableSource.add(cpampRow(5, { latency_ms: 0, normalized_total_input_tokens: 999 }));
    f.writableSource.add(cpampRow(6, { raw_json: JSON.stringify(usagePayloadNumber(5)) }));
    f.writableSource.add(
      cpampRow(7, { raw_json: JSON.stringify(usagePayloadNumber(7, { accounting_version: 1 })) })
    );
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.preconditions).toEqual({
      missingExecutionId: 2,
      duplicateExecutionId: 1,
      invalidTimestamp: 1,
      invalidTokens: 1,
      incompleteBreakdown: 1,
      invalidBreakdownIdentity: 1,
      nonPositiveLatency: 1,
      invalidJson: 1,
    });
    expect(report).toMatchObject({ lastId: 7, inserted: 2, verification: { exact: false } });
  });

  test('CPAMP normalized columns win over raw counters, with snapshot fallback and safe metadata', async () => {
    const f = fixture(0);
    f.writableSource.add(
      cpampRow(1, {
        account_snapshot: '',
        path: '/v1/messages?key=SECRET',
        api_key_hash: 'not-a-hash',
        raw_json: JSON.stringify(
          usagePayloadNumber(1, {
            token_breakdown: null,
            accounting_version: 1,
            record_kind: 'supplementary',
            instance_id: 'import-instance',
            effective_service_tier: 'priority',
          })
        ),
      })
    );
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(true);
    expect(
      f.reader
        .query(
          'SELECT input_total, input_uncached, output_total, record_kind, api_key_id FROM events'
        )
        .get()
    ).toEqual({
      input_total: 950,
      input_uncached: 100,
      output_total: 200,
      record_kind: 2,
      api_key_id: null,
    });
    expect(
      f.reader
        .query(
          "SELECT kind, value FROM dim WHERE kind IN ('path','tier','account','instance') ORDER BY kind"
        )
        .all()
    ).toEqual([
      { kind: 'account', value: 'Synthetic account' },
      { kind: 'instance', value: 'import-instance' },
      { kind: 'path', value: '/v1/messages' },
      { kind: 'tier', value: 'auto' },
      { kind: 'tier', value: 'priority' },
      { kind: 'tier', value: 'standard' },
    ]);
    expect(new TextDecoder().decode(f.reader.serialize())).not.toContain('SECRET');
  });

  test('model suffixes use the live owner and hourly sums remain exact above the JS integer range', async () => {
    const f = fixture(0);
    for (const index of [1, 2])
      f.writableSource.add(
        cpampRow(index, {
          timestamp_ms: Date.UTC(2026, 10, 1),
          model: 'display-only',
          requested_model: 'client-model(high)',
          resolved_model: '',
          normalized_total_input_tokens: 5_000_000_000_000_001,
          normalized_uncached_input_tokens: 5_000_000_000_000_001,
          normalized_cache_read_tokens: 0,
          normalized_cache_creation_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 5_000_000_000_000_001,
          raw_json: JSON.stringify(usagePayloadNumber(index, { accounting_version: 1 })),
        })
      );
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(true);
    expect(report.verification.hours[0].source.input_total).toBe('10000000000000002');
    const add = createCpampRollups(f.writableSource.db, {
      coverage_event_id: 2,
      min_bucket_ms: Date.UTC(2026, 10, 1),
      max_bucket_ms: Date.UTC(2026, 10, 1),
    });
    add({
      bucket_ms: Date.UTC(2026, 10, 1),
      calls: 2,
      input_tokens: '10000000000000002',
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: '10000000000000002',
    });
    const checked = await runCpampJob(f.store, f.source, {
      mode: 'verify',
      governor: fakeIo().governor,
    });
    expect(checked.verification.rollups.complete).toBe(true);
    expect(checked.verification.rollups.hours[0].cpamp.input_total).toBe('10000000000000002');
    expect(checked.verification.exact).toBe(true);
    expect(
      f.reader
        .query(
          `SELECT m.value AS model, b.value AS billing, r.value AS requested FROM events e
      JOIN dim m ON m.id=e.model_id JOIN dim b ON b.id=e.billing_model_id
      JOIN dim r ON r.id=e.requested_model_id LIMIT 1`
        )
        .get()
    ).toEqual({
      model: 'client-model',
      billing: 'client-model',
      requested: 'client-model(high)',
    });
  });

  test('paces every source/read-write and verification chunk by reported bytes', async () => {
    const f = fixture(1001);
    const io = fakeIo();
    let calls = 0;
    await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: io.governor,
      ioBytes: () => ({ read: ++calls * 2_000_000, written: calls * 2_000_000 }),
    });
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(calls % 2).toBe(0);
    expect(io.clock.now()).toBe((calls / 2) * 1000);
    expect(io.governor.counters).toMatchObject({
      bytesRead: calls * 1_000_000,
      bytesWritten: calls * 1_000_000,
    });
  });

  test('keeps the unsuffixed grouping model and the full requested model when its column is absent', async () => {
    const f = fixture(0);
    f.writableSource.add(cpampRow(1, { model: 'client-model(high)', requested_model: '' }));
    const report = await runCpampJob(f.store, f.source, {
      mode: 'import',
      governor: fakeIo().governor,
    });
    expect(report.verification.exact).toBe(true);
    expect(
      f.reader
        .query(
          `SELECT m.value AS model, r.value AS requested FROM events e
      JOIN dim m ON m.id=e.model_id JOIN dim r ON r.id=e.requested_model_id`
        )
        .get()
    ).toEqual({
      model: 'client-model',
      requested: 'client-model(high)',
    });
  });

  test('refuses a corrupt cursor or a source whose maximum ID moved behind it', async () => {
    const f = fixture(1);
    for (const cursor of ['bad', '-1', '2']) {
      f.store.setMeta('import:cpamp:last_id', cursor);
      await expect(
        runCpampJob(f.store, f.source, { mode: 'import', governor: fakeIo().governor })
      ).rejects.toThrow('import cursor');
    }
    expect(scalar(f.reader, 'SELECT count(*) FROM events')).toBe(0);
  });

  test('requires a query-only CPAMP handle and checks cancellation before any chunk', async () => {
    const f = fixture();
    await expect(
      runCpampJob(f.store, f.writableSource.db, { mode: 'import', governor: fakeIo().governor })
    ).rejects.toThrow('read-only');
    const signal = AbortSignal.abort();
    await expect(
      runCpampJob(f.store, f.source, { mode: 'import', governor: fakeIo().governor, signal })
    ).rejects.toThrow();
    expect(f.store.getMeta('import:cpamp:last_id')).toBeNull();
  });
});
