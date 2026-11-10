import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkAccountListFresh } from '../src/features/authFiles/modelAccess/staleCheck';

const read = (path: string) => readFileSync(path, 'utf8');

describe('B1: batch enable/disable never leaves an unhandled rejection', () => {
  test('batchSetStatus handles a throw from its guarded section', () => {
    const source = read('src/features/authFiles/hooks/useAuthFilesData.ts');
    const body = source.slice(
      source.indexOf('const batchSetStatus = useCallback('),
      source.indexOf('const batchDownload = useCallback(')
    );
    // The body awaits the writes and then calls assertCurrent(), which throws when the source
    // changed meanwhile; without a catch that surfaces as an unhandled rejection in the handler.
    expect(body).toContain('sourceScope.assertCurrent()');
    expect(body).toMatch(/\} catch \(/);
    // A changed source is silent (the new view owns the screen); anything else is reported.
    expect(body).toMatch(/catch \([^)]*\) \{\s*if \(!sourceScope\.isCurrent\(\)\) return;/);
  });
});

describe('B2: the models dialog shows the effective state, not a provider-list guess', () => {
  test('the provider-list-only check is gone and the dialog resolves cells like the matrix', () => {
    expect(read('src/features/authFiles/constants.ts')).not.toContain('isModelExcluded');
    const dialog = read('src/features/authFiles/components/AuthFileModelsModal.tsx');
    expect(dialog).toContain('buildMatrix(inventory)');
    expect(dialog).toContain('useSourceModelAccess(');
    expect(dialog).not.toContain('getModelsForAuthFile');
  });
});

describe('B3: the credential sheet does not overwrite a list changed elsewhere', () => {
  const cases: Array<{
    name: string;
    touched: boolean;
    openedWith: string[] | null;
    current: string[] | null;
    expected: 'untouched' | 'fresh' | 'stale';
  }> = [
    {
      name: 'the list is not being written',
      touched: false,
      openedWith: ['a'],
      current: ['b'],
      expected: 'untouched',
    },
    {
      name: 'unchanged since the sheet opened',
      touched: true,
      openedWith: ['a', 'B'],
      current: ['b', 'A'],
      expected: 'fresh',
    },
    {
      name: 'none then and none now',
      touched: true,
      openedWith: null,
      current: [],
      expected: 'fresh',
    },
    {
      name: 'a rule was added elsewhere',
      touched: true,
      openedWith: ['a'],
      current: ['a', 'x'],
      expected: 'stale',
    },
    {
      name: 'the list was removed elsewhere',
      touched: true,
      openedWith: ['a'],
      current: null,
      expected: 'stale',
    },
    {
      name: 'a list was created elsewhere',
      touched: true,
      openedWith: null,
      current: ['x'],
      expected: 'stale',
    },
  ];
  for (const item of cases) {
    test(item.name, async () => {
      let reads = 0;
      const result = await checkAccountListFresh({
        touched: item.touched,
        openedWith: item.openedWith,
        read: async () => {
          reads += 1;
          return item.current;
        },
      });
      expect(result.status).toBe(item.expected);
      // No file is downloaded when the list is not part of the save.
      expect(reads).toBe(item.touched ? 1 : 0);
      if (result.status === 'stale') expect(result.current).toEqual(item.current);
    });
  }

  test('the sheet runs the check before it patches the credential', () => {
    const source = read('src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor.ts');
    const save = source.slice(source.indexOf('const handlePrefixProxySave = async'));
    expect(save.indexOf('checkAccountListFresh(')).toBeGreaterThan(-1);
    expect(save.indexOf('checkAccountListFresh(')).toBeLessThan(save.indexOf('patchFields('));
  });
});
