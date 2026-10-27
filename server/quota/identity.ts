import { createHash } from 'node:crypto';
import type { PoolProviderId } from '../../src/domain/quotaPool/types';

/** The legacy digest is retained so attribution never rewrites sample foreign keys. */
export function legacyAccountId(provider: PoolProviderId, authIndex: string): string {
  return `${provider}:${createHash('sha256').update(`${provider}\0${authIndex}`).digest('hex')}`;
}

export function sourceAccountId(instanceId: string, legacyId: string): string {
  return `${instanceId}:${legacyId}`;
}

export interface LegacySourceMapping {
  provider: PoolProviderId;
  instanceId: string;
}

/** Prior deployment provenance, not a provider-to-origin routing configuration.
 * Codex history came from Codex8317; Claude history came from Claude8319.
 * These stable manifest IDs identify those deployments. Never infer replacements.
 */
export const LEGACY_SOURCE_MAPPING: readonly LegacySourceMapping[] = [
  { provider: 'claude', instanceId: 'claude-primary' },
  { provider: 'codex', instanceId: 'codex-primary' },
];
