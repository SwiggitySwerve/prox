import { describe, expect, test } from 'bun:test';
import { quotaTargetsForList } from '@/features/authFiles/quotaSlot';
import { pageOfAuthFiles, type AuthFilesFilters } from '@/features/authFiles/unifiedList';
import type { AuthFileItem } from '@/types';

const filters: AuthFilesFilters = {
  provider: 'all',
  statusFilterMode: 'all',
  search: '',
  sortMode: 'default',
  compactMode: false,
  pageSize: 2,
  source: 'all',
  revision: 0,
};
const claude = (name: string, extra: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name,
  type: 'claude',
  authIndex: name,
  ...extra,
});
const names = (list: AuthFileItem[], page: number, f = filters) =>
  quotaTargetsForList(list, f, page, 'all').map((entry) => entry.file.name);

describe('quota targets derived from a re-read credential list', () => {
  const before = [claude('b.json'), claude('c.json')];

  test('a credential the re-read added on the shown page is a target', () => {
    const after = [...before, claude('a.json')];
    expect(names(before, 1)).toEqual(['b.json', 'c.json']);
    expect(names(after, 1)).toEqual(['a.json', 'b.json']);
  });

  test('a list change that moves cards between pages follows the current page', () => {
    const after = [claude('a.json'), claude('aa.json'), ...before];
    expect(names(before, 2)).toEqual(['b.json', 'c.json']); // clamps to the only page
    expect(names(after, 2)).toEqual(['b.json', 'c.json']); // page 2 now holds what page 1 held
    expect(names(after, 1)).toEqual(['a.json', 'aa.json']);
  });

  test('a page past the end of a shrunken list clamps to the last page', () => {
    expect(names([claude('a.json'), claude('b.json'), claude('c.json')], 9)).toEqual(['c.json']);
  });

  test('filters and sort apply: disabled and filtered-out cards are not targets', () => {
    const list = [claude('a.json', { disabled: true }), claude('b.json'), claude('c.json')];
    expect(names(list, 1)).toEqual(['b.json']); // the disabled card takes a slot but has no quota
    expect(names(list, 1, { ...filters, search: 'c.json' })).toEqual(['c.json']);
    expect(names(list, 1, { ...filters, sortMode: 'az', pageSize: 3 })).toEqual([
      'b.json',
      'c.json',
    ]);
  });

  test('pageOfAuthFiles is the page the group renders', () => {
    const page = pageOfAuthFiles(
      [claude('a.json'), claude('b.json'), claude('c.json')],
      filters,
      2
    );
    expect(page.pageItems.map((file) => file.name)).toEqual(['c.json']);
    expect([page.totalPages, page.currentPage, page.sorted.length]).toEqual([2, 2, 3]);
  });
});
