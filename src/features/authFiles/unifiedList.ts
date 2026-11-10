/** Pure logic of the unified Auth Files page: one filter set applied to every source group. */
import { isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';
import {
  countCredentials,
  credentialHealth,
  isNamedProvider,
  providerOfCredential,
  type CredentialCounts,
} from '@/features/authFiles/credentialFacts';
import { buildWildcardSearch, matchesAuthFileSearch } from '@/features/authFiles/logic';
import { listKeyOf } from '@/features/authFiles/models/matrixView';
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

/** Raw provider key of a credential; kept under this name for existing importers. */
export const providerOfAuthFile = providerOfCredential;

/** Group key for the provider tabs and groups: credentials without a usable type share 'unknown'. */
export const OTHER_PROVIDER_GROUP = 'unknown';
export const providerGroupOf = (file: AuthFileItem): string => {
  const key = providerOfCredential(file);
  return isNamedProvider(key) ? key : OTHER_PROVIDER_GROUP;
};

/** The chips use the same three-way health as every count: active, problem, disabled. */
export function matchesStatusFilter(file: AuthFileItem, mode: AuthFilesStatusFilterMode): boolean {
  switch (mode) {
    case 'enabled':
      return credentialHealth(file) === 'active';
    case 'disabled':
      return credentialHealth(file) === 'disabled';
    case 'problem':
      return credentialHealth(file) === 'problem';
    case 'all':
      return true;
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

type ListFilters = Pick<AuthFilesFilters, 'provider' | 'statusFilterMode' | 'search'>;

/** Status, provider and search filters, in one place so the chips, counts and groups agree. */
export function filterAuthFiles(files: AuthFileItem[], filters: ListFilters): AuthFileItem[] {
  const search = filters.search.trim();
  const wildcard = buildWildcardSearch(search);
  return files.filter(
    (file) =>
      matchesStatusFilter(file, filters.statusFilterMode) &&
      (filters.provider === 'all' || providerGroupOf(file) === filters.provider) &&
      matchesAuthFileSearch(file, search, wildcard)
  );
}

/** What "Delete all" removes: exactly the credentials the group shows, minus runtime-only ones. */
export const deletableShown = (files: AuthFileItem[], filters: ListFilters): AuthFileItem[] =>
  filterAuthFiles(files, filters).filter((file) => !isRuntimeOnlyAuthFile(file));

/** Stable grouping by provider (alphabetical, "Other" last), keeping the sort within each. */
export function groupByProvider(files: AuthFileItem[]): AuthFileItem[] {
  const groups = new Map<string, AuthFileItem[]>();
  for (const file of files) {
    const key = providerGroupOf(file);
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }
  const rank = (key: string) => (key === OTHER_PROVIDER_GROUP ? 1 : 0);
  return [...groups.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .flatMap((key) => groups.get(key) ?? []);
}

/**
 * The way into the Models screen: one provider of one source, or the Rules tab with one account's
 * exclusion list selected (the list key is the Models screen's own, from listKeyOf).
 */
export function modelsScreenPath(source: string, provider: string, account?: string): string {
  const params = new URLSearchParams({ source });
  if (provider) params.set('provider', provider);
  if (account) {
    params.set('tab', 'rules');
    params.set('list', listKeyOf({ kind: 'account', name: account }));
  }
  return `/auth-files/models?${params.toString()}`;
}

/** A persisted provider with no credentials in scope shows everything, and the tabs say so. */
export const resolveProviderFilter = (requested: string, available: readonly string[]): string =>
  requested !== 'all' && available.includes(requested) ? requested : 'all';

/** A persisted source that is gone, or the only one left (no pills to undo it), means all. */
export const resolveSourceFilter = (requested: string, sourceIds: readonly string[]): string =>
  sourceIds.length > 1 && sourceIds.includes(requested) ? requested : 'all';

export type SourceAnswer = {
  /** loading: no answer yet; error: the last read failed; ready: the last read succeeded. */
  state: 'loading' | 'ready' | 'error';
  /** The source's files in the shared inventory; undefined until read once. */
  files: readonly AuthFileItem[] | undefined;
};

export type SourcesSummary =
  | { status: 'loading' }
  | { status: 'ready'; sources: number; unreachable: number; counts: CredentialCounts };

/** The page header: nothing is counted until every source has answered once. */
export function summarizeSources(answers: readonly SourceAnswer[]): SourcesSummary {
  if (answers.some((answer) => answer.state === 'loading')) return { status: 'loading' };
  return {
    status: 'ready',
    sources: answers.length,
    unreachable: answers.filter((answer) => answer.state === 'error').length,
    counts: countCredentials(answers.flatMap((answer) => answer.files ?? [])),
  };
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
