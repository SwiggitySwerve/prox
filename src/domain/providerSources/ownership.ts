/** The OAuth name "anthropic" is the credential type "claude". */
export const canonicalCredentialProvider = (name: string): string => {
  const key = name.trim().toLowerCase();
  return key === 'anthropic' ? 'claude' : key;
};

interface OwnedSource {
  readonly source: { readonly instanceId: string; readonly providers?: readonly string[] };
}

/**
 * Every proxy instance accepts every provider, so a new credential must be sent to the one
 * declared for its provider. Undeclared providers stay on the selected source. An unavailable
 * owner is still the destination: callers report it rather than writing to another instance.
 */
export function credentialDestination<T extends OwnedSource>(
  sources: readonly T[],
  selectedInstanceId: string,
  provider: string
): T | undefined {
  const key = canonicalCredentialProvider(provider);
  return (
    sources.find((view) => view.source.providers?.includes(key)) ??
    sources.find((view) => view.source.instanceId === selectedInstanceId)
  );
}

/** The owning source of an auth file being uploaded elsewhere; unreadable files are left alone. */
export function misplacedCredentialOwner<T extends OwnedSource>(
  sources: readonly T[],
  instanceId: string,
  fileText: string
): T | null {
  let type: unknown;
  try {
    type = (JSON.parse(fileText) as { type?: unknown } | null)?.type;
  } catch {
    return null;
  }
  if (typeof type !== 'string' || !type) return null;
  const owner = credentialDestination(sources, instanceId, type);
  return owner && owner.source.instanceId !== instanceId ? owner : null;
}
