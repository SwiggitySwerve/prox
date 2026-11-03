import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AccountResetBlocker, PoolProviderId } from '@/domain/quotaPool/types';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';

/** Match opaque pool identities only inside the authenticated source's inventory. */
export function findPoolResetFile(
  files: readonly AuthFileItem[],
  instanceId: string,
  provider: PoolProviderId,
  accountId: string
): AuthFileItem | undefined {
  const matches = files.filter((file) => {
    const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    if (
      !authIndex ||
      (file.provider ?? file.type) !== provider ||
      (file.provider !== undefined && file.type !== undefined && file.provider !== file.type)
    )
      return false;
    const digest = bytesToHex(sha256(new TextEncoder().encode(`${provider}\0${authIndex}`)));
    // Accounts recorded before sources existed keep their legacy id (QuotaStore.accountIdFor).
    // The caller lists only the pool's own source, so the legacy form stays source-bound.
    return (
      accountId === `${instanceId}:${provider}:${digest}` || accountId === `${provider}:${digest}`
    );
  });
  // An ambiguous inventory must never choose a credential arbitrarily.
  return matches.length === 1 ? matches[0] : undefined;
}

export function poolResetReasonKey(blocker: AccountResetBlocker | null): string {
  if (blocker?.startsWith('ineligible:')) return 'quota_pool.reset_ineligible';
  return `quota_pool.reset_${blocker ?? 'unavailable'}`;
}
