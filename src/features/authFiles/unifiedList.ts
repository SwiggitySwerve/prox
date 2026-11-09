/** Pure logic of the unified Auth Files page: one filter set applied to every source group. */
import { isProblemAuthFile, normalizeProviderKey } from '@/features/authFiles/constants';
import { buildWildcardSearch, matchesAuthFileSearch } from '@/features/authFiles/logic';
import type { AuthFilesSortMode, AuthFilesStatusFilterMode } from '@/features/authFiles/uiState';
import type { AuthFileItem } from '@/types';

export type AuthFilesFilters = {
  /** Provider key or 'all'. */
  provider: string;
  statusFilterMode: AuthFilesStatusFilterMode;
  search: string;
  sortMode: AuthFilesSortMode;
  compactMode: boolean;
  pageSize: number;
  /** Source instance id or 'all'. */
  source: string;
  /** Bumps whenever a filter changes, so each source group returns to its first page. */
  revision: number;
};

export const providerOfAuthFile = (file: AuthFileItem): string =>
  normalizeProviderKey(String(file.type ?? file.provider ?? ''));

export function matchesStatusFilter(file: AuthFileItem, mode: AuthFilesStatusFilterMode): boolean {
  switch (mode) {
    case 'enabled':
      return file.disabled !== true;
    case 'disabled':
      return file.disabled === true;
    case 'problem':
      return isProblemAuthFile(file);
    case 'all':
      return true;
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

/** Status, provider and search filters, in one place so the chips, counts and groups agree. */
export function filterAuthFiles(
  files: AuthFileItem[],
  filters: Pick<AuthFilesFilters, 'provider' | 'statusFilterMode' | 'search'>
): AuthFileItem[] {
  const search = filters.search.trim();
  const wildcard = buildWildcardSearch(search);
  return files.filter(
    (file) =>
      matchesStatusFilter(file, filters.statusFilterMode) &&
      (filters.provider === 'all' || providerOfAuthFile(file) === filters.provider) &&
      matchesAuthFileSearch(file, search, wildcard)
  );
}

/** Stable grouping by provider (alphabetical), keeping the chosen sort within each provider. */
export function groupByProvider(files: AuthFileItem[]): AuthFileItem[] {
  const groups = new Map<string, AuthFileItem[]>();
  for (const file of files) {
    const key = providerOfAuthFile(file);
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }
  return [...groups.keys()].sort().flatMap((key) => groups.get(key) ?? []);
}

/**
 * Credential list load, machine M1 (docs/design/auth-files-models-plan.md). useAuthFilesData keeps
 * four fields (`loading`, `refreshing`, `error`, `files`); this names the state they encode:
 *
 *   loading      first, foreground read; skeletons, no files yet
 *   refreshing   background read with files on screen
 *   error        last read failed and there are no files to show
 *   error-stale  last read failed; the last good files stay on screen under the error banner
 *   empty        read succeeded with no files
 *   ready        read succeeded with files
 *
 * Exposed as `data-machine="auth-files-list" data-state` on each source group. Documentation only:
 * the hook's transitions are unchanged.
 */
export type AuthFilesListState =
  'loading' | 'refreshing' | 'error' | 'error-stale' | 'empty' | 'ready';

export function listLoadState(input: {
  loading: boolean;
  refreshing: boolean;
  error: string;
  fileCount: number;
}): AuthFilesListState {
  if (input.loading) return 'loading';
  if (input.error) return input.fileCount > 0 ? 'error-stale' : 'error';
  if (input.refreshing) return 'refreshing';
  return input.fileCount > 0 ? 'ready' : 'empty';
}
