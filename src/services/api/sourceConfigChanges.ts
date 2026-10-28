import type { SourceOwner } from './sourceSession';
const listeners = new Set<(owner: SourceOwner) => void>();

/** Source-local invalidation without importing UI stores into the transport. */
export function subscribeSourceConfigChanges(listener: (owner: SourceOwner) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function notifySourceConfigChanged(owner: SourceOwner): void {
  // A cache observer cannot undo an acknowledged server write or prevent other
  // views from invalidating. Never log observer errors that may contain config.
  for (const listener of [...listeners]) {
    try {
      listener(owner);
    } catch {
      console.error('A source configuration cache could not be invalidated.');
    }
  }
}
