import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  compareModelRecency,
  sortRowsNewestFirst,
} from '../src/features/authFiles/models/matrixView';

const newestFirst = (ids: string[]) => [...ids].sort(compareModelRecency);

describe('model recency order', () => {
  test('a higher version comes first, however many parts it has', () => {
    expect(
      newestFirst(['claude-opus-4-5', 'claude-opus-5', 'claude-opus-5-1', 'claude-opus-4-8'])
    ).toEqual(['claude-opus-5-1', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-5']);
    expect(newestFirst(['x-5-1', 'x-5-5', 'x-5-2', 'x-5', 'x-4-8', 'x-4-7', 'x-4-6'])).toEqual([
      'x-5-5',
      'x-5-2',
      'x-5-1',
      'x-5',
      'x-4-8',
      'x-4-7',
      'x-4-6',
    ]);
  });

  test('versions compare as numbers, so 4-10 is newer than 4-9', () => {
    expect(newestFirst(['m-4-9', 'm-4-10'])).toEqual(['m-4-10', 'm-4-9']);
  });

  test('dotted versions read like dashed ones', () => {
    expect(newestFirst(['gpt-5-codex', 'gpt-5.2', 'gpt-5.1-codex', 'gpt-4.1'])).toEqual([
      'gpt-5.2',
      'gpt-5.1-codex',
      'gpt-5-codex',
      'gpt-4.1',
    ]);
  });

  test('a trailing date is not a version; within one version the newer date goes first', () => {
    expect(
      newestFirst([
        'claude-haiku-4-5-20251001',
        'claude-haiku-4-5-20250801',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5-20250929',
      ])
    ).toEqual([
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20250801',
    ]);
    // An undated id is the alias of the latest snapshot: it leads its dated siblings.
    expect(newestFirst(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'])).toEqual([
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
    ]);
  });

  test('a version later in the id is found past the family name', () => {
    expect(newestFirst(['claude-3-5-sonnet-20241022', 'claude-3-7-sonnet'])).toEqual([
      'claude-3-7-sonnet',
      'claude-3-5-sonnet-20241022',
    ]);
    expect(newestFirst(['qwen3-coder-plus', 'qwen3-max-preview', 'glm-4.6'])).toEqual([
      'glm-4.6',
      'qwen3-coder-plus',
      'qwen3-max-preview',
    ]);
  });

  test('equal versions fall back to the name, ascending', () => {
    expect(newestFirst(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])).toEqual([
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  test('ids without a version go last, by name', () => {
    expect(newestFirst(['zeta', 'claude-opus-4-5', 'alpha', 'gemini-pro-latest'])).toEqual([
      'claude-opus-4-5',
      'alpha',
      'gemini-pro-latest',
      'zeta',
    ]);
  });

  test('the order does not depend on the input order', () => {
    const ids = ['a-4', 'b-5', 'c', 'd-4-5', 'e-5-5-20250101', 'f-5-5'];
    expect(newestFirst(ids)).toEqual(newestFirst([...ids].reverse()));
  });

  test('sortRowsNewestFirst orders rows by model id and leaves its input alone', () => {
    const rows = [{ model: 'claude-haiku-4-5' }, { model: 'claude-opus-5-5' }];
    expect(sortRowsNewestFirst(rows).map((row) => row.model)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-4-5',
    ]);
    expect(rows.map((row) => row.model)).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
  });
});

describe('newest-first columns and centred bubbles (wiring)', () => {
  const section = readFileSync('src/features/authFiles/models/ModelsHubSection.tsx', 'utf8');
  const scss = readFileSync('src/features/authFiles/models/ModelsPage.module.scss', 'utf8');
  const block = (selector: string) => {
    const start = scss.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return scss.slice(start, scss.indexOf('\n}\n', start));
  };

  test('the hub section sorts the matrix rows before filtering them', () => {
    expect(section).toMatch(/sortRowsNewestFirst\(buildMatrix\(inventory\)\)/);
  });

  test('cell chips centre their icon-and-text group on both axes, with centred text', () => {
    const cell = block('.cell');
    expect(cell).toContain('justify-content: center');
    expect(cell).toContain('align-items: center');
    expect(cell).toContain('text-align: center');
    expect(cell).not.toContain('text-align: left');
    // The drift dot must not push the group off centre.
    expect(cell).not.toContain('margin-left: auto');
  });

  test('row and account buttons centre their label', () => {
    const buttons = scss.slice(
      scss.indexOf('.rowAction,\n.miniButton {'),
      scss.indexOf(".rowAction[data-action='edit-rule']")
    );
    expect(buttons).toContain('justify-content: center');
    expect(buttons).toContain('align-items: center');
    expect(buttons).toContain('text-align: center');
  });
});
