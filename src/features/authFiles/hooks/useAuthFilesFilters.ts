import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { clampCardPageSize, normalizeProviderKey } from '@/features/authFiles/constants';
import {
  isAuthFilesSortMode,
  isAuthFilesStatusFilterMode,
  readAuthFilesUiState,
  readPersistedAuthFilesCompactMode,
  writeAuthFilesUiState,
  writePersistedAuthFilesCompactMode,
  type AuthFilesSortMode,
  type AuthFilesStatusFilterMode,
  type AuthFilesUiState,
} from '@/features/authFiles/uiState';
import { ALL_SOURCES } from '@/features/authFiles/components/AuthFilesSourceNav';
import type { AuthFilesFilters } from '@/features/authFiles/unifiedList';

export const DEFAULT_REGULAR_PAGE_SIZE = 9;
export const DEFAULT_COMPACT_PAGE_SIZE = 12;

const normalizePersistedStatusFilterMode = (value: unknown): AuthFilesStatusFilterMode | null => {
  if (value === 'disabledProblem') return 'problem';
  return isAuthFilesStatusFilterMode(value) ? value : null;
};

/** Older pages stored filters per source; the unified page reads the first source's as a fallback. */
function readInitialState(fallbackSource?: string): AuthFilesUiState | null {
  return readAuthFilesUiState() ?? (fallbackSource ? readAuthFilesUiState(fallbackSource) : null);
}

/**
 * One filter set for every source on the Auth Files page. Persisted with the same
 * `authFilesPage.uiState` shape as before; `source` is a new optional field.
 */
export function useAuthFilesFilters(fallbackSource?: string) {
  const [provider, setProviderState] = useState('all');
  const [statusFilterMode, setStatusState] = useState<AuthFilesStatusFilterMode>('all');
  const [search, setSearchState] = useState('');
  const [sortMode, setSortState] = useState<AuthFilesSortMode>('default');
  const [compactMode, setCompactMode] = useState(false);
  const [source, setSourceState] = useState(ALL_SOURCES);
  const [pageSizeByMode, setPageSizeByMode] = useState({
    regular: DEFAULT_REGULAR_PAGE_SIZE,
    compact: DEFAULT_COMPACT_PAGE_SIZE,
  });
  const [pageSizeInput, setPageSizeInput] = useState(String(DEFAULT_REGULAR_PAGE_SIZE));
  const [revision, setRevision] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const bump = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (hydrated) return;
    const persistedCompactMode = readPersistedAuthFilesCompactMode();
    if (typeof persistedCompactMode === 'boolean') setCompactMode(persistedCompactMode);
    const persisted = readInitialState(fallbackSource);
    if (persisted) {
      if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
        setProviderState(normalizeProviderKey(persisted.filter));
      }
      const status = normalizePersistedStatusFilterMode(persisted.statusFilterMode);
      if (status) setStatusState(status);
      else if (persisted.problemOnly === true) setStatusState('problem');
      else if (persisted.disabledOnly === true) setStatusState('disabled');
      if (typeof persistedCompactMode !== 'boolean' && typeof persisted.compactMode === 'boolean') {
        setCompactMode(persisted.compactMode);
      }
      if (typeof persisted.search === 'string') setSearchState(persisted.search);
      if (isAuthFilesSortMode(persisted.sortMode)) setSortState(persisted.sortMode);
      if (typeof persisted.source === 'string' && persisted.source.trim()) {
        setSourceState(persisted.source);
      }
      const legacy =
        typeof persisted.pageSize === 'number' && Number.isFinite(persisted.pageSize)
          ? clampCardPageSize(persisted.pageSize)
          : null;
      setPageSizeByMode({
        regular:
          typeof persisted.regularPageSize === 'number' &&
          Number.isFinite(persisted.regularPageSize)
            ? clampCardPageSize(persisted.regularPageSize)
            : (legacy ?? DEFAULT_REGULAR_PAGE_SIZE),
        compact:
          typeof persisted.compactPageSize === 'number' &&
          Number.isFinite(persisted.compactPageSize)
            ? clampCardPageSize(persisted.compactPageSize)
            : (legacy ?? DEFAULT_COMPACT_PAGE_SIZE),
      });
    }
    setHydrated(true);
  }, [fallbackSource, hydrated]);

  const pageSize = compactMode ? pageSizeByMode.compact : pageSizeByMode.regular;

  useEffect(() => {
    if (!hydrated) return;
    writeAuthFilesUiState({
      filter: provider,
      statusFilterMode,
      problemOnly: statusFilterMode === 'problem',
      disabledOnly: statusFilterMode === 'disabled',
      compactMode,
      search,
      page: 1,
      pageSize,
      regularPageSize: pageSizeByMode.regular,
      compactPageSize: pageSizeByMode.compact,
      sortMode,
      source,
    });
    writePersistedAuthFilesCompactMode(compactMode);
  }, [
    compactMode,
    hydrated,
    pageSize,
    pageSizeByMode,
    provider,
    search,
    sortMode,
    source,
    statusFilterMode,
  ]);

  useEffect(() => {
    setPageSizeInput(String(pageSize));
  }, [pageSize]);

  const setCurrentModePageSize = useCallback(
    (next: number) => {
      setPageSizeByMode((current) =>
        compactMode ? { ...current, compact: next } : { ...current, regular: next }
      );
      bump();
    },
    [bump, compactMode]
  );

  const commitPageSizeInput = useCallback(
    (rawValue: string) => {
      const value = Number(rawValue.trim());
      if (!rawValue.trim() || !Number.isFinite(value)) {
        setPageSizeInput(String(pageSize));
        return;
      }
      const next = clampCardPageSize(value);
      setCurrentModePageSize(next);
      setPageSizeInput(String(next));
    },
    [pageSize, setCurrentModePageSize]
  );

  const handlePageSizeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const rawValue = event.currentTarget.value;
      setPageSizeInput(rawValue);
      const parsed = Number(rawValue.trim());
      if (!rawValue.trim() || !Number.isFinite(parsed)) return;
      const rounded = Math.round(parsed);
      if (clampCardPageSize(rounded) !== rounded) return;
      setCurrentModePageSize(rounded);
    },
    [setCurrentModePageSize]
  );

  const withBump =
    <T>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      bump();
    };

  const filters: AuthFilesFilters = {
    provider: normalizeProviderKey(provider) || 'all',
    statusFilterMode,
    search,
    sortMode,
    compactMode,
    pageSize,
    source,
    revision,
  };

  return {
    filters,
    pageSizeInput,
    setProvider: withBump(setProviderState),
    setStatusFilterMode: withBump(setStatusState),
    setSearch: withBump(setSearchState),
    setSortMode: (value: string) => {
      if (!isAuthFilesSortMode(value)) return;
      setSortState(value);
      bump();
    },
    setCompactMode,
    setSource: withBump(setSourceState),
    handlePageSizeChange,
    commitPageSizeInput,
    clear: () => {
      setProviderState('all');
      setStatusState('all');
      setSearchState('');
      setSourceState(ALL_SOURCES);
      bump();
    },
  };
}
