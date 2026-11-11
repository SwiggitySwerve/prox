/**
 * Pure rules of the card's quota slot and of the page-wide "Refresh quota" button.
 * React-free; tests/authFilesQuotaSlot.test.ts consumes it directly.
 */
import { isRuntimeOnlyAuthFile, type AuthFileQuotaFilter } from '@/features/authFiles/constants';
import { resolveAuthFileQuotaType } from '@/features/authFiles/logic';
import { pageOfAuthFiles, type AuthFilesFilters } from '@/features/authFiles/unifiedList';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { AuthFileItem } from '@/types';
import { isDisabledAuthFile } from '@/utils/quota/validators';

export type QuotaUnavailableReason = 'runtime' | 'disabled' | 'unsupported';

/** Why a card has no quota to read, or null when it has. */
export function quotaUnavailableReason(
  file: AuthFileItem,
  filter: AuthFileQuotaFilter
): QuotaUnavailableReason | null {
  if (isRuntimeOnlyAuthFile(file)) return 'runtime';
  if (resolveAuthFileQuotaType(file, filter) === null) return 'unsupported';
  if (isDisabledAuthFile(file)) return 'disabled';
  return null;
}

/** The shown credentials whose quota a page-wide refresh loads, in the order they are shown. */
export function quotaRefreshTargets(
  files: readonly AuthFileItem[],
  filter: AuthFileQuotaFilter
): QuotaFileEntry[] {
  const targets: QuotaFileEntry[] = [];
  for (const file of files) {
    const type = resolveAuthFileQuotaType(file, filter);
    if (type && quotaUnavailableReason(file, filter) === null) targets.push({ file, type });
  }
  return targets;
}

/** The quota targets of the page a group shows for this credential list, filters and page. */
export function quotaTargetsForList(
  files: AuthFileItem[],
  filters: Pick<
    AuthFilesFilters,
    'provider' | 'statusFilterMode' | 'search' | 'sortMode' | 'pageSize'
  >,
  page: number,
  quotaFilter: AuthFileQuotaFilter
): QuotaFileEntry[] {
  return quotaRefreshTargets(pageOfAuthFiles(files, filters, page).pageItems, quotaFilter);
}

export type QuotaSlotState =
  | { kind: 'unavailable'; reason: QuotaUnavailableReason }
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** refreshing: a reload runs over retained data; stale: the last reload failed. */
  | { kind: 'loaded'; refreshing: boolean; stale: boolean }
  | { kind: 'failed' };

/** Which of the slot's five same-sized states a card shows. */
export function selectQuotaSlotState(input: {
  reason: QuotaUnavailableReason | null;
  status: 'idle' | 'loading' | 'success' | 'error' | undefined;
  /** Quota data is on hand: a success, or Claude usage retained across a reload. */
  hasData: boolean;
}): QuotaSlotState {
  if (input.reason) return { kind: 'unavailable', reason: input.reason };
  const status = input.status ?? 'idle';
  if (status === 'success' || input.hasData) {
    return { kind: 'loaded', refreshing: status === 'loading', stale: status === 'error' };
  }
  if (status === 'loading') return { kind: 'loading' };
  if (status === 'error') return { kind: 'failed' };
  return { kind: 'idle' };
}

export type PageQuotaRefresh = {
  status: 'idle' | 'running' | 'done';
  total: number;
  settled: number;
  failed: number;
};

export type PageQuotaRefreshEvent =
  { type: 'start'; total: number } | { type: 'settled'; ok: boolean } | { type: 'finish' };

export const INITIAL_PAGE_QUOTA_REFRESH: PageQuotaRefresh = {
  status: 'idle',
  total: 0,
  settled: 0,
  failed: 0,
};

/** Progress and outcome of one page-wide refresh; failures themselves show on the cards. */
export function pageQuotaRefreshReducer(
  state: PageQuotaRefresh,
  event: PageQuotaRefreshEvent
): PageQuotaRefresh {
  switch (event.type) {
    case 'start':
      if (state.status === 'running' || event.total <= 0) return state;
      return { status: 'running', total: event.total, settled: 0, failed: 0 };
    case 'settled':
      if (state.status !== 'running' || state.settled >= state.total) return state;
      return {
        ...state,
        settled: state.settled + 1,
        failed: state.failed + (event.ok ? 0 : 1),
      };
    case 'finish':
      return state.status === 'running' ? { ...state, status: 'done' } : state;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
