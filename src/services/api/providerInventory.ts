import { isRecord } from '@/utils/helpers';

export type ProviderFamily =
  | 'gemini'
  | 'interactions'
  | 'codex'
  | 'meta'
  | 'xai'
  | 'claude'
  | 'vertex'
  | 'openai-compatibility';
export const providerConfigurationConflict = () =>
  new Error('Provider configuration changed or is ambiguous; refresh and try again.');

export const readProviderGroups = (
  raw: unknown,
  family: ProviderFamily
): Record<string, unknown>[] => {
  if (!isRecord(raw)) throw providerConfigurationConflict();
  if (raw['api-keys'] === undefined) return [];
  if (!isRecord(raw['api-keys'])) throw providerConfigurationConflict();
  const groups = raw['api-keys'][family];
  if (groups === undefined) return [];
  if (
    !Array.isArray(groups) ||
    !groups.every((g) => isRecord(g) && Array.isArray(g.keys) && g.keys.every(isRecord))
  )
    throw providerConfigurationConflict();
  return groups;
};
/** Reject malformed inventory instead of publishing a successful empty provider panel. */
export function validateProviderInventory(raw: unknown): void {
  if (!isRecord(raw)) throw providerConfigurationConflict();
  if (raw['api-keys'] === undefined) return;
  if (!isRecord(raw['api-keys'])) throw providerConfigurationConflict();
  for (const family of Object.keys(raw['api-keys'])) {
    readProviderGroups(raw, family as ProviderFamily);
  }
}
