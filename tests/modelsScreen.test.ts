import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMatrix, CELL_KINDS } from '../src/features/authFiles/modelAccess/resolve';
import {
  accountListKind,
  cellLabelKey,
  countServed,
  filterAccounts,
  filterRows,
  legacyModelsTarget,
  listDiff,
  listKeyOf,
  targetOfListKey,
} from '../src/features/authFiles/models/matrixView';
import { inventory } from './fixtures/modelAccess';

const rows = buildMatrix(inventory());

describe('Models screen filters', () => {
  test('served view keeps models any account serves; not-served keeps the rest', () => {
    expect(filterRows(rows, '', 'served').map((row) => row.model)).not.toContain(
      'claude-3-7-sonnet'
    );
    expect(filterRows(rows, '', 'excluded').map((row) => row.model)).toEqual([
      'claude-3-7-sonnet',
      'claude-3-5-haiku',
    ]);
    expect(countServed(rows)).toEqual({ served: 6, total: 8 });
  });

  test('model search matches ids and aliases, case-insensitively', () => {
    expect(filterRows(rows, 'SONNET-4', 'all').map((row) => row.model)).toEqual([
      'claude-sonnet-4-5',
      'claude-sonnet-4-0',
    ]);
    expect(filterRows(rows, 'opus', 'all').map((row) => row.model)).toEqual([
      'claude-opus-4-5',
      'claude-opus-4-1',
    ]);
  });

  test('account search matches the label or the file name', () => {
    const accounts = inventory().accounts;
    expect(filterAccounts(accounts, 'team-b').map((account) => account.name)).toEqual([
      'team-b.json',
    ]);
    expect(filterAccounts(accounts, '  ')).toHaveLength(4);
  });

  test('list kind: own, inherits, unknown', () => {
    const [teamA, teamB] = inventory().accounts;
    expect(accountListKind(teamA)).toBe('inherits');
    expect(accountListKind(teamB)).toBe('own');
    expect(accountListKind({ ...teamA, ownList: { status: 'unknown', message: 'x' } })).toBe(
      'unknown'
    );
  });

  test('every cell kind has a label key', () => {
    const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8')).model_access;
    for (const kind of CELL_KINDS) {
      const cell =
        kind === 'served'
          ? { kind, via: 'provider' as const }
          : kind === 'wildcard'
            ? { kind, rule: 'x*', list: 'provider' as const, drift: false }
            : kind === 'excluded-own' || kind === 'excluded-provider'
              ? { kind, rule: 'x', drift: false }
              : { kind };
      const key = cellLabelKey(cell as never);
      expect(en[key]).toBeString();
      expect(en[`kind_${kind.replace('-', '_')}`]).toBeString();
    }
  });
});

describe('preview helpers', () => {
  test('listDiff reports added and removed rules case-insensitively', () => {
    expect(listDiff({ before: ['a', 'B'], after: ['b', 'c'] })).toEqual({
      added: ['c'],
      removed: ['a'],
    });
    expect(listDiff({ before: null, after: ['x'] })).toEqual({ added: ['x'], removed: [] });
  });

  test('rules list key round-trips, including file names with colons', () => {
    expect(targetOfListKey(listKeyOf({ kind: 'provider' }))).toEqual({ kind: 'provider' });
    expect(targetOfListKey(listKeyOf({ kind: 'account', name: 'a:b.json' }))).toEqual({
      kind: 'account',
      name: 'a:b.json',
    });
  });
});

describe('routes', () => {
  test('old provider-list editor links open the Rules tab with source and provider kept', () => {
    expect(legacyModelsTarget('?source=alpha&provider=Claude', 'rules')).toBe(
      '/auth-files/models?source=alpha&provider=claude&tab=rules'
    );
    expect(legacyModelsTarget('', 'rules')).toBe('/auth-files/models?tab=rules');
  });

  test('the Models route is registered and the old editor route redirects', () => {
    const routes = readFileSync('src/router/MainRoutes.tsx', 'utf8');
    expect(routes).toContain("path: '/auth-files/models'");
    expect(routes).toContain('<ModelsPage />');
    expect(routes).toMatch(
      /'\/auth-files\/oauth-excluded', element: <LegacyModelsRedirect tab="rules" \/>/
    );
    // The alias editor keeps its own screen; the Models screen links to it.
    expect(routes).toContain('<AuthFilesOAuthModelAliasEditPage />');
  });

  test('the Models screen exposes its machines to tests and agents', () => {
    const page = readFileSync('src/features/authFiles/models/ModelsPage.tsx', 'utf8');
    expect(page).toContain('data-machine="model-inventory"');
    expect(page).toContain('data-machine="model-edit-session"');
    const dialog = readFileSync('src/features/authFiles/models/ModelEditDialog.tsx', 'utf8');
    expect(dialog).toContain('data-machine="model-edit-session"');
  });

  test('every model_access key exists in all six locales', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'].map(
      (locale) => JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')).model_access
    );
    const keys = Object.keys(locales[0]);
    for (const locale of locales) expect(Object.keys(locale)).toEqual(keys);
  });
});
