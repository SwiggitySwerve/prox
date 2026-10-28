import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PoolProviderId, PoolWindow } from '../../src/domain/quotaPool/types';
import { DAY_MS, type QuotaSample, type StoredAccount } from './types';
import { legacyAccountId, sourceAccountId, type LegacySourceMapping } from './identity';

type AccountRow = Omit<
  StoredAccount,
  'disabled' | 'retired' | 'instanceId' | 'plan' | 'planObservedAtMs'
> & {
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
      CREATE TABLE IF NOT EXISTS quota_account_sources (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        instanceId TEXT NOT NULL,
        sourceAccountId TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS quota_account_sources_instance
        ON quota_account_sources(instanceId);
      CREATE TABLE IF NOT EXISTS quota_legacy_sources (
        provider TEXT PRIMARY KEY CHECK (provider IN ('claude', 'codex')),
        instanceId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_account_plans (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        plan TEXT NOT NULL,
        observedAtMs INTEGER NOT NULL
      );
    `);
  }

  listAccounts(): StoredAccount[] {
    return this.db
      .query<
        AccountRow & {
          instanceId: string | null;
          plan: string | null;
          planObservedAtMs: number | null;
        },
        []
      >(
        `
        SELECT a.*, s.instanceId, p.plan, p.observedAtMs AS planObservedAtMs
        FROM quota_accounts a
        LEFT JOIN quota_account_sources s ON s.accountId = a.id
        LEFT JOIN quota_account_plans p ON p.accountId = a.id
        ORDER BY a.provider, a.id
      `
      )
      .all()
      .map(({ instanceId, plan, planObservedAtMs, ...row }) => ({
        ...row,
        ...(instanceId === null ? {} : { instanceId }),
        ...(plan === null || planObservedAtMs === null ? {} : { plan, planObservedAtMs }),
        disabled: row.disabled === 1,
        retired: row.retired === 1,
      }));
  }

  /** Add ownership only. Unknown legacy providers remain unresolved and untouched.
   * A conflicting attribution or alias collision rolls back the entire mapping.
   */
  migrateLegacySources(
    mappings: readonly LegacySourceMapping[],
    knownInstanceIds: readonly string[]
  ): void {
    const providers = new Set<PoolProviderId>();
    for (const mapping of mappings) {
      if (providers.has(mapping.provider) || !knownInstanceIds.includes(mapping.instanceId)) {
        throw new Error('Ambiguous or unknown legacy quota source');
      }
      providers.add(mapping.provider);
    }
    this.db
      .transaction(() => {
        for (const { provider, instanceId } of mappings) {
          const previous = this.db
            .query<{ instanceId: string }, [string]>(
              'SELECT instanceId FROM quota_legacy_sources WHERE provider = ?'
            )
            .get(provider);
          if (previous && previous.instanceId !== instanceId) {
            throw new Error('Conflicting legacy quota source');
          }
          this.db
            .query(
              `
          INSERT INTO quota_legacy_sources (provider, instanceId) VALUES (?, ?)
          ON CONFLICT(provider) DO NOTHING
        `
            )
            .run(provider, instanceId);
          const unresolved = this.db
            .query<{ id: string }, [string]>(
              `
          SELECT id FROM quota_accounts WHERE provider = ?
          AND NOT EXISTS (SELECT 1 FROM quota_account_sources WHERE accountId = id)
        `
            )
            .all(provider);
          const insert = this.db.query(`
          INSERT INTO quota_account_sources (accountId, instanceId, sourceAccountId)
          VALUES (?, ?, ?)
        `);
          for (const { id } of unresolved)
            insert.run(id, instanceId, sourceAccountId(instanceId, id));
        }
      })
      .immediate();
  }

  /** Resolve a source-local occurrence, including explicitly attributed legacy IDs. */
  accountIdFor(instanceId: string, provider: PoolProviderId, authIndex: string): string {
    const id = sourceAccountId(instanceId, legacyAccountId(provider, authIndex));
    return (
      this.db
        .query<{ accountId: string }, [string]>(
          'SELECT accountId FROM quota_account_sources WHERE sourceAccountId = ?'
        )
        .get(id)?.accountId ?? id
    );
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

  /** Call only with a validated, complete inventory for this instance/provider.
   * Omitting instanceId supports legacy fixtures and touches only unresolved rows.
   */
  recordInventory(
    provider: PoolProviderId,
    accounts: StoredAccount[],
    nowMs: number,
    instanceId?: string
  ): void {
    const ids = new Set<string>();
    for (const account of accounts) {
      if (
        account.provider !== provider ||
        account.instanceId !== instanceId ||
        ids.has(account.id)
      ) {
        throw new Error('Invalid quota inventory');
      }
      ids.add(account.id);
    }
    this.db.transaction(() => {
      this.db
        .query(
          `
        UPDATE quota_accounts SET retired = 1 WHERE provider = ? AND
        ${
          instanceId === undefined
            ? 'NOT EXISTS (SELECT 1 FROM quota_account_sources WHERE accountId = id)'
            : 'id IN (SELECT accountId FROM quota_account_sources WHERE instanceId = ?)'
        }
      `
        )
        .run(...(instanceId === undefined ? [provider] : [provider, instanceId]));
      const existing = this.db.query<
        { provider: PoolProviderId; instanceId: string | null },
        [string]
      >(`
        SELECT a.provider, s.instanceId FROM quota_accounts a
        LEFT JOIN quota_account_sources s ON s.accountId = a.id WHERE a.id = ?
      `);
      const upsert = this.db.query(`
        INSERT INTO quota_accounts
          (id, provider, name, email, disabled, retired, lastSeenAtMs, lastErrorAtMs)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email,
          disabled = excluded.disabled, retired = 0, lastSeenAtMs = excluded.lastSeenAtMs
      `);
      for (const account of accounts) {
        const previous = existing.get(account.id);
        if (
          previous &&
          (previous.provider !== provider || (previous.instanceId ?? undefined) !== instanceId)
        ) {
          throw new Error('Invalid quota identity');
        }
        if (
          !previous &&
          instanceId !== undefined &&
          !account.id.startsWith(`${instanceId}:${provider}:`)
        ) {
          throw new Error('Invalid quota identity');
        }
        upsert.run(
          account.id,
          provider,
          account.name,
          account.email,
          Number(account.disabled),
          nowMs,
          account.lastErrorAtMs
        );
        if (!previous && instanceId !== undefined) {
          this.db
            .query(
              `
            INSERT INTO quota_account_sources (accountId, instanceId, sourceAccountId)
            VALUES (?, ?, ?)
          `
            )
            .run(account.id, instanceId, account.id);
        }
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

  recordPlan(accountId: string, plan: string, nowMs: number): void {
    this.db
      .query(
        `INSERT INTO quota_account_plans (accountId, plan, observedAtMs) VALUES (?, ?, ?)
         ON CONFLICT(accountId) DO UPDATE SET plan = excluded.plan, observedAtMs = excluded.observedAtMs`
      )
      .run(accountId, plan, nowMs);
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
