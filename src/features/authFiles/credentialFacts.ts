/**
 * The facts every screen states about a credential, defined once: which provider it belongs to and
 * whether it is active, disabled or has a problem. The sidebar, Dashboard, Auth Files, Models and
 * Quota all count with these, so their numbers agree.
 */
import { isProblemAuthFile, isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { isDisabledAuthFile } from '@/utils/quota/validators';
import type { AuthFileItem } from '@/types';

/**
 * Provider key of a credential, as the hub keys its provider lists and model catalogs. The hub
 * sends the same value as `type` and `provider`; `type` is read first for older payloads.
 */
export const providerOfCredential = (file: AuthFileItem): string =>
  normalizeOAuthProviderKey(String(file.type ?? file.provider ?? ''));

/** False for the placeholders a credential without a usable type gets. */
export const isNamedProvider = (provider: string): boolean =>
  provider !== '' && provider !== 'unknown' && provider !== 'empty';

export type CredentialHealth = 'active' | 'problem' | 'disabled';

export const CREDENTIAL_HEALTHS: readonly CredentialHealth[] = ['active', 'problem', 'disabled'];

export const isCredentialDisabled = (file: AuthFileItem): boolean =>
  isDisabledAuthFile(file) ||
  (typeof file.status === 'string' && file.status.trim().toLowerCase() === 'disabled');

/** Exactly one of three: switched off by the operator, needing attention, or serving. */
export function credentialHealth(file: AuthFileItem): CredentialHealth {
  if (isCredentialDisabled(file)) return 'disabled';
  return isProblemAuthFile(file) ? 'problem' : 'active';
}

export type CredentialCounts = Record<CredentialHealth, number> & {
  total: number;
  /** Config API keys and other credentials that are not files. */
  runtime: number;
};

/** total = active + problem + disabled, always. */
export function countCredentials(files: readonly AuthFileItem[]): CredentialCounts {
  const counts: CredentialCounts = { total: 0, active: 0, problem: 0, disabled: 0, runtime: 0 };
  for (const file of files) {
    counts.total += 1;
    counts[credentialHealth(file)] += 1;
    if (isRuntimeOnlyAuthFile(file)) counts.runtime += 1;
  }
  return counts;
}
