import { createHash } from 'node:crypto';
import type { PoolProviderId } from '../../src/domain/quotaPool/types';
import type { StoredAccount } from './types';

export type InventorySourceState = 'ok' | 'unavailable';

export interface InventorySourceStatus {
  instanceId: string;
  provider: PoolProviderId;
  state: InventorySourceState;
}

export interface InventoryView {
  version: string;
  syncedAtMs: number | null;
  sources: (InventorySourceStatus & {
    accounts: { accountId: string; sourceAccountId: string; disabled: boolean }[];
  })[];
}

/** Accounts that currently belong to a source's inventory. Unattributed legacy rows have none. */
function active(accounts: readonly StoredAccount[]) {
  return accounts.filter((account) => !account.retired && account.instanceId !== undefined);
}

/**
 * Membership version: a truncated sha256 of the sorted `[instanceId, provider, accountId,
 * disabled]` tuples of the active accounts. Names and emails never enter it, so it is safe to
 * return to any authenticated caller and is stable while membership is.
 */
export function inventoryVersion(accounts: readonly StoredAccount[]): string {
  const tuples = active(accounts)
    .map((account) =>
      JSON.stringify([account.instanceId, account.provider, account.id, account.disabled])
    )
    .sort();
  return createHash('sha256').update(tuples.join('\n')).digest('hex').slice(0, 16);
}

/** The read model behind `GET /v1/inventory`: ids and flags only, no names or emails. */
export function buildInventory(
  accounts: readonly StoredAccount[],
  sources: readonly InventorySourceStatus[],
  syncedAtMs: number | null
): InventoryView {
  const current = active(accounts);
  return {
    version: inventoryVersion(accounts),
    syncedAtMs,
    sources: sources.map((source) => ({
      ...source,
      accounts: current
        .filter(
          (account) =>
            account.instanceId === source.instanceId && account.provider === source.provider
        )
        .map((account) => ({
          accountId: account.id,
          sourceAccountId: account.sourceAccountId ?? account.id,
          disabled: account.disabled,
        })),
    })),
  };
}
