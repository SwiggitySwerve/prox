import { describe, expect, test } from 'bun:test';
import {
  arrangeRows,
  hiddenStorageKey,
  hiddenSummary,
  readHidden,
  withHidden,
  writeHidden,
} from '../src/features/authFiles/models/hiddenModels';

/** A Storage stand-in; `fail` makes every call throw, like a blocked or private-mode store. */
function memoryStorage(fail = false) {
  const data = new Map<string, string>();
  const guard = () => {
    if (fail) throw new Error('storage blocked');
  };
  return {
    data,
    getItem: (key: string) => (guard(), data.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void data.set(key, value)),
    removeItem: (key: string) => (guard(), void data.delete(key)),
  };
}

const rows = ['m-new', 'm-old-1', 'm-old-2', 'm-old-3'].map((model) => ({ model }));

describe('hidden models', () => {
  test('the key is per hub and provider', () => {
    expect(hiddenStorageKey('alpha', 'claude')).not.toBe(hiddenStorageKey('beta', 'claude'));
    expect(hiddenStorageKey('alpha', 'claude')).not.toBe(hiddenStorageKey('alpha', 'codex'));
  });

  test('hidden ids round-trip through storage; none hidden removes the key', () => {
    const storage = memoryStorage();
    const key = hiddenStorageKey('alpha', 'claude');
    writeHidden(storage, key, new Set(['m-old-2', 'm-old-1']));
    expect([...readHidden(storage, key)].sort()).toEqual(['m-old-1', 'm-old-2']);
    writeHidden(storage, key, new Set());
    expect(storage.data.has(key)).toBe(false);
  });

  test('missing, blocked or garbled storage hides nothing and never throws', () => {
    const key = hiddenStorageKey('alpha', 'claude');
    expect(readHidden(null, key).size).toBe(0);
    expect(readHidden(memoryStorage(true), key).size).toBe(0);
    expect(() => writeHidden(memoryStorage(true), key, new Set(['m']))).not.toThrow();
    const garbled = memoryStorage();
    garbled.data.set(key, '{not json');
    expect(readHidden(garbled, key).size).toBe(0);
    garbled.data.set(key, JSON.stringify(['m-old-1', 7, null]));
    expect([...readHidden(garbled, key)]).toEqual(['m-old-1']);
  });

  test('hide one: it leaves the bands for the Hidden group', () => {
    const { shown, collapsed } = arrangeRows(rows, new Set(['m-old-1']), () => false);
    expect(shown.map((row) => row.model)).toEqual(['m-new', 'm-old-2', 'm-old-3']);
    expect(collapsed.map((row) => row.model)).toEqual(['m-old-1']);
  });

  test('hide all not served adds them all at once; unhide takes one back', () => {
    const hidden = withHidden(new Set(), ['m-old-1', 'm-old-2', 'm-old-3'], true);
    expect(arrangeRows(rows, hidden, () => false).shown.map((row) => row.model)).toEqual([
      'm-new',
    ]);
    const back = withHidden(hidden, ['m-old-2'], false);
    expect(back.has('m-old-2')).toBe(false);
    expect(hidden.has('m-old-2')).toBe(true);
  });

  test('a staged or searched-for hidden model stays in its band', () => {
    const hidden = new Set(['m-old-1', 'm-old-2']);
    const { shown, collapsed } = arrangeRows(rows, hidden, (row) => row.model === 'm-old-2');
    expect(shown.map((row) => row.model)).toContain('m-old-2');
    expect(collapsed.map((row) => row.model)).toEqual(['m-old-1']);
  });

  test('the summary counts hidden models still on for some account', () => {
    const on = new Set(['m-old-3']);
    const { collapsed } = arrangeRows(rows, new Set(['m-old-1', 'm-old-3']), () => false);
    expect(hiddenSummary(collapsed, (row) => on.has(row.model))).toEqual({
      count: 2,
      stillOn: 1,
    });
  });
});
