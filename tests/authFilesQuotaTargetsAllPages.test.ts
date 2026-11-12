import { describe, expect, test } from 'bun:test';
import { quotaTargetsShown } from '@/features/authFiles/quotaSlot';
import type { AuthFilesFilters } from '@/features/authFiles/unifiedList';
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
const claude = (name: string): AuthFileItem => ({ name, type: 'claude', authIndex: name });

describe('a refresh targets every card the filters show, on every page', () => {
  const list = ['a.json', 'b.json', 'c.json', 'd.json', 'e.json'].map(claude);

  test('cards past the first page are targets too', () => {
    const names = quotaTargetsShown(list, filters, 'all').map((entry) => entry.file.name);
    expect(names).toEqual(['a.json', 'b.json', 'c.json', 'd.json', 'e.json']);
  });

  test('cards the filters hide are not', () => {
    const names = quotaTargetsShown(list, { ...filters, search: 'c.json' }, 'all').map(
      (entry) => entry.file.name
    );
    expect(names).toEqual(['c.json']);
  });
});
