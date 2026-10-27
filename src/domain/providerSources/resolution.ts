import { validatedManagementBase } from '@/utils/connection';
import type { SourceDiscovery, SourceResolution } from './types';

/** Exact alias membership, never same-origin guessing or provider-name routing. */
export function resolveConnectionSources(
  apiBase: string,
  appOrigin: string,
  discovery: SourceDiscovery | null
): SourceResolution {
  const base = validatedManagementBase(apiBase);
  const url = new URL(base);
  const selected =
    url.origin === appOrigin &&
    discovery?.sources.find((source) =>
      [source.publicBasePath, ...source.aliases].some((path) => `${appOrigin}${path}` === base)
    );
  if (selected && discovery) {
    return {
      mode: 'deployment',
      revision: discovery.revision,
      selectedInstanceId: selected.instanceId,
      sources: discovery.sources.map((source) => ({
        ...source,
        apiBase: `${appOrigin}${source.publicBasePath}`,
      })),
    };
  }
  return {
    mode: 'external',
    revision: base,
    selectedInstanceId: 'external',
    sources: [
      {
        instanceId: 'external',
        label: url.host,
        publicBasePath: '',
        aliases: [],
        authScope: 'external',
        apiBase: base,
      },
    ],
  };
}
