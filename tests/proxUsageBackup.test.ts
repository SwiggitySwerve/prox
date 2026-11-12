import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBackupConfig, UsageBackup } from '../server/usage/backup';
import { normalizeUsagePayload } from '../server/usage/normalize';
import { UsageStore } from '../server/usage/store';
import { INGEST } from '../server/usage/types';
import { usagePayloadNumber } from './fixtures/usagePayloads';
import { fakeIo } from './helpers/usageIo';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function fixture() {
  const root = mkdtempSync('/dev/shm/prox-backup-test-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new UsageStore({ events: ':memory:', raw: null });
  cleanups.push(() => store.close());
  store.insert(
    Array.from({ length: 100 }, (_, i) => {
      const result = normalizeUsagePayload(JSON.stringify(usagePayloadNumber(i)));
      if (result.kind !== 'event') throw new Error('invalid fixture');
      return { event: result.event, raw: null };
    }),
    INGEST.subscribed
  );
  let status = 200;
  const uploads: { path: string; bytes: Buffer; snapshot: Buffer; at: number }[] = [];
  const io = fakeIo({ bytesPerSecond: 100_000 });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const directory = readdirSync(root).find((name) => name.startsWith('prox-usage-backup-'))!;
      const files = readdirSync(join(root, directory));
      const snapshot = readFileSync(join(root, directory, files[0]));
      const bytes = Buffer.from(await request.arrayBuffer());
      uploads.push({ path: new URL(request.url).pathname, bytes, snapshot, at: io.clock.now() });
      return new Response('', { status });
    },
  });
  cleanups.push(() => server.stop(true));
  const config = {
    endpoint: server.url.origin,
    bucket: 'synthetic-backups',
    accessKeyId: 'SYNTHETIC-KEY',
    secretAccessKey: 'SYNTHETIC-SECRET',
    tmpfsDir: root,
  };
  return {
    root,
    store,
    uploads,
    io,
    config,
    setStatus: (value: number) => {
      status = value;
    },
  };
}

describe('usage tmpfs backups', () => {
  test('Bun S3 signer streams exact SQLite bytes with pacing; daily and Sunday weekly keys', async () => {
    expect(typeof Bun.S3Client).toBe('function');
    const f = fixture();
    const sunday = Date.UTC(2026, 10, 15, 23, 59);
    const backup = new UsageBackup(f.config, { governor: f.io.governor, now: () => sunday });
    expect(backup.lastSuccessAtMs).toBeNull();
    const report = await backup.run(f.store);
    expect(report.keys).toEqual([
      'usage/daily/usage-20261115.sqlite',
      'usage/weekly/usage-20261115.sqlite',
    ]);
    expect(f.uploads.map((upload) => upload.path)).toEqual(
      report.keys.map((key) => `/synthetic-backups/${key}`)
    );
    expect(f.uploads).toHaveLength(2);
    for (const upload of f.uploads) {
      expect(upload.bytes).toEqual(upload.snapshot);
      expect(upload.bytes.length).toBe(report.sizeBytes);
      expect(upload.bytes.subarray(0, 16).toString()).toBe('SQLite format 3\0');
      // Independent SQLite read of the uploaded bytes, without using the source handle.
      const db = Database.deserialize(upload.bytes);
      try {
        expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM events').get()!.n).toBe(100);
      } finally {
        db.close();
      }
    }
    expect(f.uploads[1].bytes).toEqual(f.uploads[0].bytes);
    expect(f.io.governor.counters.bytesRead).toBeGreaterThanOrEqual(report.sizeBytes * 2);
    expect(f.io.governor.counters.bytesWritten).toBeGreaterThanOrEqual(report.sizeBytes * 2);
    expect(f.uploads[0].at).toBeGreaterThanOrEqual((report.sizeBytes * 2 * 1000) / 100_000);
    expect(f.uploads[1].at - f.uploads[0].at).toBeGreaterThanOrEqual(
      (report.sizeBytes * 2 * 1000) / 100_000
    );
    expect(backup.lastSuccessAtMs).toBe(sunday);
    expect(readdirSync(f.root)).toEqual([]);
  });

  test('weekday has one key; upload failure deletes temp file and preserves last successful timestamp', async () => {
    const f = fixture();
    let now = Date.UTC(2026, 10, 16);
    const backup = new UsageBackup(f.config, { governor: f.io.governor, now: () => now });
    expect((await backup.run(f.store)).keys).toEqual(['usage/daily/usage-20261116.sqlite']);
    f.setStatus(503);
    now += 86_400_000;
    await expect(backup.run(f.store)).rejects.toThrow('HTTP 503');
    expect(backup.lastSuccessAtMs).toBe(Date.UTC(2026, 10, 16));
    expect(readdirSync(f.root)).toEqual([]);
    expect(f.uploads).toHaveLength(2);
  });

  test('refuses insufficient tmpfs before VACUUM or network activity and refuses a disk directory', async () => {
    const f = fixture();
    const size = f.store.databaseSizeBytes();
    const backup = new UsageBackup(f.config, {
      governor: f.io.governor,
      filesystemInfo: () => ({ isTmpfs: true, freeBytes: 2 * size - 1 }),
    });
    await expect(backup.run(f.store)).rejects.toThrow('twice the database size');
    expect(backup.lastSuccessAtMs).toBeNull();
    expect(f.uploads).toHaveLength(0);
    expect(readdirSync(f.root)).toEqual([]);
    const disk = new UsageBackup(f.config, {
      governor: f.io.governor,
      filesystemInfo: () => ({ isTmpfs: false, freeBytes: Infinity }),
    });
    await expect(disk.run(f.store)).rejects.toThrow('must be tmpfs');
  });

  test('cancellation and VACUUM failures leave no temporary file or successful timestamp', async () => {
    const f = fixture();
    const backup = new UsageBackup(f.config, { governor: f.io.governor });
    await expect(backup.run(f.store, AbortSignal.abort())).rejects.toThrow();
    expect(readdirSync(f.root)).toEqual([]);
    const vacuum = f.store.vacuumInto.bind(f.store);
    f.store.vacuumInto = (path) => {
      vacuum(path);
      throw new Error('synthetic snapshot failure');
    };
    await expect(backup.run(f.store)).rejects.toThrow('synthetic snapshot failure');
    expect(readdirSync(f.root)).toEqual([]);
    expect(backup.lastSuccessAtMs).toBeNull();
    expect(f.uploads).toHaveLength(0);
  });

  test('loads JSON or env configuration without including secrets in validation errors', () => {
    const f = fixture();
    const path = join(f.root, 'config.json');
    writeFileSync(path, JSON.stringify(f.config));
    expect(loadBackupConfig(path, {})).toEqual(f.config);
    expect(loadBackupConfig(path, { PROX_USAGE_BACKUP_BUCKET: 'override' }).bucket).toBe(
      'override'
    );
    expect(() => loadBackupConfig(undefined, {})).toThrow('endpoint');
    expect(
      () =>
        new UsageBackup(
          { ...f.config, endpoint: 'https://KEY:SECRET@example.test' },
          { governor: f.io.governor }
        )
    ).toThrow('without credentials');
  });
});
