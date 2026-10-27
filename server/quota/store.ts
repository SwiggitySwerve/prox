import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PoolProviderId, PoolWindow } from '../../src/domain/quotaPool/types';
import { DAY_MS, type QuotaSample, type StoredAccount } from './types';

type AccountRow = Omit<StoredAccount, 'disabled' | 'retired'> & {
  disabled: number;
  retired: number;
};

/** Owns durable account metadata and normalized quota observations; never stores credentials. */
export class QuotaStore {
  private readonly db: Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      const path = resolve(databasePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS quota_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        name TEXT NOT NULL,
        email TEXT,
        disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
        retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
        lastSeenAtMs INTEGER NOT NULL,
        lastErrorAtMs INTEGER
      );
      CREATE INDEX IF NOT EXISTS quota_accounts_provider ON quota_accounts(provider);
      CREATE TABLE IF NOT EXISTS quota_samples (
        accountId TEXT NOT NULL REFERENCES quota_accounts(id),
        window TEXT NOT NULL CHECK (window IN ('weekly', 'five-hour')),
        observedAtMs INTEGER NOT NULL,
        remainingPercent REAL CHECK (remainingPercent BETWEEN 0 AND 100),
        resetAtMs INTEGER,
        periodHours REAL CHECK (periodHours IS NULL OR periodHours > 0),
        PRIMARY KEY (accountId, window, observedAtMs)
      );
      CREATE INDEX IF NOT EXISTS quota_samples_time ON quota_samples(observedAtMs);
      CREATE INDEX IF NOT EXISTS quota_samples_window_time
        ON quota_samples(window, observedAtMs);
    `);
  }

  listAccounts(): StoredAccount[] {
    return this.db
      .query<AccountRow, []>('SELECT * FROM quota_accounts ORDER BY provider, id')
      .all()
      .map((row) => ({ ...row, disabled: row.disabled === 1, retired: row.retired === 1 }));
  }

  listSamples(fromMs: number, toMs: number, window?: PoolWindow): QuotaSample[] {
    if (window !== undefined) {
      return this.db
        .query<QuotaSample, [number, number, PoolWindow]>(
          `
        SELECT * FROM quota_samples WHERE observedAtMs BETWEEN ? AND ? AND window = ?
        ORDER BY observedAtMs, accountId, window
      `
        )
        .all(fromMs, toMs, window);
    }
    return this.db
      .query<QuotaSample, [number, number]>(
        `
      SELECT * FROM quota_samples WHERE observedAtMs BETWEEN ? AND ?
      ORDER BY observedAtMs, accountId, window
    `
      )
      .all(fromMs, toMs);
  }

  firstSampleAtMs(): number | null {
    return (
      this.db
        .query<{ atMs: number | null }, []>('SELECT MIN(observedAtMs) AS atMs FROM quota_samples')
        .get()?.atMs ?? null
    );
  }

  /** Call only with a validated, complete inventory for this provider. */
  recordInventory(provider: PoolProviderId, accounts: StoredAccount[], nowMs: number): void {
    const ids = new Set<string>();
    for (const account of accounts) {
      if (account.provider !== provider || ids.has(account.id)) {
        throw new Error('Invalid quota inventory');
      }
      ids.add(account.id);
    }
    this.db.transaction(() => {
      this.db.query('UPDATE quota_accounts SET retired = 1 WHERE provider = ?').run(provider);
      const existing = this.db.query<{ provider: PoolProviderId }, [string]>(
        'SELECT provider FROM quota_accounts WHERE id = ?'
      );
      const upsert = this.db.query(`
        INSERT INTO quota_accounts
          (id, provider, name, email, disabled, retired, lastSeenAtMs, lastErrorAtMs)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email,
          disabled = excluded.disabled, retired = 0, lastSeenAtMs = excluded.lastSeenAtMs
      `);
      for (const account of accounts) {
        const previous = existing.get(account.id);
        if (previous && previous.provider !== provider) throw new Error('Invalid quota identity');
        upsert.run(
          account.id,
          provider,
          account.name,
          account.email,
          Number(account.disabled),
          nowMs,
          account.lastErrorAtMs
        );
      }
    })();
  }

  recordSamples(samples: QuotaSample[]): void {
    this.db.transaction(() => {
      const insert = this.db.query(`
        INSERT INTO quota_samples
          (accountId, window, observedAtMs, remainingPercent, resetAtMs, periodHours)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(accountId, window, observedAtMs) DO NOTHING
      `);
      const clearError = this.db.query(`
        UPDATE quota_accounts SET lastErrorAtMs = NULL
        WHERE id = ? AND lastErrorAtMs <= ?
      `);
      for (const sample of samples) {
        if (
          (sample.remainingPercent !== null && !Number.isFinite(sample.remainingPercent)) ||
          !Number.isSafeInteger(sample.observedAtMs) ||
          (sample.resetAtMs !== null && !Number.isSafeInteger(sample.resetAtMs)) ||
          (sample.periodHours !== null && !Number.isFinite(sample.periodHours))
        ) {
          throw new Error('Invalid quota sample');
        }
        insert.run(
          sample.accountId,
          sample.window,
          sample.observedAtMs,
          sample.remainingPercent,
          sample.resetAtMs,
          sample.periodHours
        );
        clearError.run(sample.accountId, sample.observedAtMs);
      }
    })();
  }

  markAccountError(id: string, nowMs: number): void {
    this.db.query('UPDATE quota_accounts SET lastErrorAtMs = ? WHERE id = ?').run(nowMs, id);
  }

  prune(nowMs: number): void {
    this.db.query('DELETE FROM quota_samples WHERE observedAtMs < ?').run(nowMs - 30 * DAY_MS);
  }

  close(): void {
    this.db.close();
  }
}
