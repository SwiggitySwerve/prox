import type { AuthFileItem } from '@/types';

// Inventory account/account_type may contain API keys. Unknown future fields and nested
// records are not a display contract; credential contents require the explicit editor download.
const DISPLAY_FIELDS = [
  'name',
  'type',
  'provider',
  'email',
  'projectId',
  'size',
  'authIndex',
  'runtimeOnly',
  'disabled',
  'unavailable',
  'status',
  'lastRefresh',
  'modified',
  'priority',
  'weight',
  'successCount',
  'failureCount',
  'supportsQuota',
  'quotaProvider',
  'quotaPluginId',
  'siwcBindSupported',
  'useSiwc',
  'siwcBound',
  'siwcExpiresAt',
] as const;

export function authFileDisplayMetadata(
  file: AuthFileItem
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const field of DISPLAY_FIELDS) {
    const value = file[field];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      metadata[field] = value;
  }
  return metadata;
}
