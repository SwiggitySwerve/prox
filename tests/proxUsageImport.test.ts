import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCpampJob } from '../server/usage/importCpamp';
import { normalizeUsagePayload } from '../server/usage/normalize';
import { openUsageReader, UsageStore } from '../server/usage/store';
import { INGEST } from '../server/usage/types';
import { cpampRow, createCpamp, PARENT_SESSION, V8_SESSION } from './fixtures/cpampUsage';
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
    expect(io.clock.now()).toBe(5000); // high-water read + two import + two verification chunks
    expect(io.governor.counters).toMatchObject({ bytesRead: 10_000_000, bytesWritten: 10_000_000 });
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
