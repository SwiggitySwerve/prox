/**
 * Validation and type checking functions for quota management.
 */

import { providerOfCredential } from '@/features/authFiles/credentialFacts';
import type { AuthFileItem } from '@/types';

/**
 * Quota family of a credential: its provider key (see `providerOfCredential`) with `kimi-ai`
 * merged into `kimi`, because Kimi International accounts (kimi.ai) share Kimi's quota API on
 * another host. Use `providerOfCredential` where the hub's own provider name matters.
 */
export function resolveAuthProvider(file: AuthFileItem): string {
  const provider = providerOfCredential(file);
  return provider === 'kimi-ai' ? 'kimi' : provider;
}

export function isAntigravityFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'antigravity';
}

export function isClaudeFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'claude';
}

export function isCodexFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'codex';
}

export function isDevinFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'devin';
}

export function isKimiFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'kimi';
}

export function isXaiFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'xai';
}

/** Providers rendered by a dedicated built-in quota card. */
export const BUILT_IN_QUOTA_PROVIDERS: ReadonlySet<string> = new Set([
  'antigravity',
  'claude',
  'codex',
  'devin',
  'kimi',
  'meta',
  'xai',
]);

/**
 * Generic plugin quota card for providers without a built-in card. Built-in cards win even
 * when a plugin also advertises quota for the same provider.
 */
export function isPluginQuotaFile(file: AuthFileItem): boolean {
  if (BUILT_IN_QUOTA_PROVIDERS.has(resolveAuthProvider(file))) return false;
  const supported = file.supportsQuota ?? file['supports_quota'];
  return supported === true || supported === 'true' || supported === '1';
}

export function isDisabledAuthFile(file: AuthFileItem): boolean {
  const raw = (file as { disabled?: unknown }).disabled;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}
