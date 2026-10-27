import { sourceOwnerKey, type SourceOwner } from '@/services/api/sourceSession';
import type { SourceRegistrySnapshot } from './registry';

/** A requested source never falls back to another instance. */
export function selectSource(
  snapshot: SourceRegistrySnapshot,
  instanceId: string | null,
  owner?: SourceOwner
) {
  const id = instanceId ?? snapshot.resolution?.selectedInstanceId;
  const view = snapshot.sources.find((entry) => entry.source.instanceId === id);
  if (!view?.session || view.status !== 'ready') return null;
  if (owner && sourceOwnerKey(owner) !== sourceOwnerKey(view.session.owner)) return null;
  return { ...view, session: view.session };
}
