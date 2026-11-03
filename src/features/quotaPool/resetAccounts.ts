import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AccountResetBlocker, AccountResets, PoolProviderId } from '@/domain/quotaPool/types';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';

/** Match opaque pool identities only inside the authenticated source's inventory. */
export function findPoolResetFile(
  files: readonly AuthFileItem[],
  instanceId: string,
  provider: PoolProviderId,
  /** The server's source-qualified identity, never the pool row id (which may be legacy). */
  sourceAccountId: string | null
): AuthFileItem | undefined {
  if (!sourceAccountId) return undefined;
  const matches = files.filter((file) => {
    const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    if (
      !authIndex ||
      (file.provider ?? file.type) !== provider ||
      (file.provider !== undefined && file.type !== undefined && file.provider !== file.type)
    )
      return false;
    const digest = bytesToHex(sha256(new TextEncoder().encode(`${provider}\0${authIndex}`)));
    return sourceAccountId === `${instanceId}:${provider}:${digest}`;
  });
  // An ambiguous inventory must never choose a credential arbitrarily.
  return matches.length === 1 ? matches[0] : undefined;
}

export function poolResetReasonKey(blocker: AccountResetBlocker | null): string {
  if (blocker?.startsWith('ineligible:')) return 'quota_pool.reset_ineligible';
  return `quota_pool.reset_${blocker ?? 'unavailable'}`;
}

// This tab's attempts stay separate from the server's last collection.
const spentAt = new Map<string, number>();
export const markSpent = (accountId: string) => spentAt.set(accountId, Date.now());
export const wasSpent = (accountId: string, observedAtMs: number) =>
  (spentAt.get(accountId) ?? 0) > observedAtMs;

export function poolResetStatus(
  resets: AccountResets | null,
  provider: PoolProviderId,
  spent: boolean
) {
  if (!resets) return null;
  if (spent)
    return {
      valueKey: 'quota_pool.reset_requested',
      statusKey: 'quota_pool.reset_spent',
      early: false,
    };
  if (resets.available === 0)
    return { valueKey: 'quota_pool.reset_none', statusKey: null, early: false };
  const early = provider === 'codex' && resets.usable === 0 && resets.blocker === 'not_applicable';
  return {
    valueKey: 'quota_pool.reset_held',
    statusKey:
      resets.usable > 0
        ? resets.usable === resets.available
          ? 'quota_pool.reset_usable'
          : 'quota_pool.reset_usable_count'
        : early
          ? 'quota_pool.reset_early_status'
          : poolResetReasonKey(resets.blocker),
    early,
  };
}
