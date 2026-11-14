/**
 * Hidden models: a per-browser view preference for the Models grid. Hiding a model never changes
 * which accounts serve it and is never written to the hub; it only moves the row into a collapsed
 * "Hidden" group. Stored in localStorage per hub and provider; without storage the page still
 * works and nothing is hidden.
 */

export const hiddenStorageKey = (hub: string, provider: string) =>
  `prox:models:hidden:v1:${hub}:${provider}`;

/** The browser's localStorage, or null where reading it throws (blocked or sandboxed). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

/** The hidden model ids saved under `key`; empty when storage is missing, blocked or garbled. */
export function readHidden(storage: ReadStorage | null | undefined, key: string): Set<string> {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    );
  } catch {
    return new Set();
  }
}

/** Saves the hidden ids (removes the key when none are hidden); a failed write is ignored. */
export function writeHidden(
  storage: WriteStorage | null | undefined,
  key: string,
  hidden: ReadonlySet<string>
): void {
  try {
    if (hidden.size === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify([...hidden].sort()));
  } catch {
    // A view preference only: the grid works the same without it.
  }
}

/**
 * Splits rows into those shown in their band and those collapsed into the Hidden group. A hidden
 * row stays in its band (marked hidden) while `keepVisible` holds for it: it has staged changes,
 * or a model search is active, so a search still finds it.
 */
export function arrangeRows<T extends { model: string }>(
  rows: readonly T[],
  hidden: ReadonlySet<string>,
  keepVisible: (row: T) => boolean
): { shown: T[]; collapsed: T[] } {
  const shown: T[] = [];
  const collapsed: T[] = [];
  for (const row of rows) {
    if (hidden.has(row.model) && !keepVisible(row)) collapsed.push(row);
    else shown.push(row);
  }
  return { shown, collapsed };
}

/** How many models are hidden, and how many of those some account still serves. */
export function hiddenSummary<T>(
  collapsed: readonly T[],
  isOn: (row: T) => boolean
): { count: number; stillOn: number } {
  return { count: collapsed.length, stillOn: collapsed.filter(isOn).length };
}

/** `hidden` plus or minus `models`, as a new set (the original is left alone). */
export function withHidden(
  hidden: ReadonlySet<string>,
  models: readonly string[],
  hide: boolean
): Set<string> {
  const next = new Set(hidden);
  for (const model of models) {
    if (hide) next.add(model);
    else next.delete(model);
  }
  return next;
}
