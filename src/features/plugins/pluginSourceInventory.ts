import { createPluginsApi, PluginInventoryError } from '@/services/api/plugins';
import { isRecord } from '@/utils/helpers';
import type { SourceSession } from '@/services/api/sourceSession';
import type { SourceView } from '@/services/providerSources/registry';
import type { PluginListResponse } from '@/types';

export type ReadPluginSources = () => readonly SourceView[];

/** Config is a passive capability probe; discard its body without publishing it. */
export async function probePluginSource(session: SourceSession): Promise<void> {
  session.assertCurrent();
  await session.management.get('/config');
  session.assertCurrent();
}

export async function supportsPluginSource(view: SourceView, readSources: ReadPluginSources) {
  const session = view.session;
  if (!session || view.status !== 'ready') throw new Error('Source is not authenticated');
  session.assertCurrent();
  if (!view.supportsPlugin) await probePluginSource(session);
  session.assertCurrent();
  const current = readSources().find((item) => item.session === session);
  if (!current || current.status !== 'ready') throw new Error('Source is not authenticated');
  return current.supportsPlugin;
}

export type PluginSourceInventory = { view: SourceView } & (
  | { status: 'complete'; response: PluginListResponse }
  | { status: 'unsupported' | 'stale' }
  | { status: 'unavailable'; reason: 'authentication' | 'malformed' | 'request' }
);

/** Failures are per source. Successful empty results remain distinguishable from failures. */
export function loadPluginSourceInventories(
  sources: readonly SourceView[],
  readSources: ReadPluginSources
): Promise<PluginSourceInventory[]> {
  return Promise.all(
    sources.map(async (view): Promise<PluginSourceInventory> => {
      try {
        if (!(await supportsPluginSource(view, readSources)))
          return { view, status: 'unsupported' };
        const response = await createPluginsApi(view.session!).list();
        view.session!.assertCurrent();
        return { view, status: 'complete', response };
      } catch (error: unknown) {
        try {
          view.session?.assertCurrent();
        } catch {
          return { view, status: 'stale' };
        }
        const reason =
          error instanceof PluginInventoryError
            ? 'malformed'
            : !view.session ||
                view.status !== 'ready' ||
                (isRecord(error) && (error.status === 401 || error.status === 403))
              ? 'authentication'
              : 'request';
        return { view, status: 'unavailable', reason };
      }
    })
  );
}

/** A missing or invalid explicit owner never falls back to another source. */
export function resolvePluginDestination(
  sources: readonly SourceView[],
  requested: string | null,
  external: boolean,
  selectedInstanceId?: string
): SourceView | undefined {
  const id = requested ?? (external ? selectedInstanceId : undefined);
  return sources.find((view) => view.source.instanceId === id);
}
