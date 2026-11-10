import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMatrix, CELL_KINDS } from '../src/features/authFiles/modelAccess/resolve';
import {
  accountListKind,
  cellLabelKey,
  cellShortKey,
  countServed,
  filterAccounts,
  filterRows,
  legacyModelsTarget,
  listDiff,
  listKeyOf,
  listSignature,
  resolveListKey,
  resolveProviderParam,
  rowActionFor,
  sharedLabels,
  targetOfListKey,
} from '../src/features/authFiles/models/matrixView';
import { account, inventory, runtimeAccount } from './fixtures/modelAccess';

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
      expect(en[cellShortKey(cell as never)]).toBeString();
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
    expect(legacyModelsTarget('?provider=grok', 'rules')).toBe(
      '/auth-files/models?provider=xai&tab=rules'
    );
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

describe('provider in the URL', () => {
  test('an alias reads and writes the provider the credentials use (grok is xai)', () => {
    expect(resolveProviderParam('grok', ['claude', 'xai'])).toEqual({
      provider: 'xai',
      param: 'xai',
    });
    expect(resolveProviderParam(' Claude ', ['claude'])).toEqual({
      provider: 'claude',
      param: 'claude',
    });
  });

  test('a provider this hub has no credentials for is replaced by the first it has, or none', () => {
    expect(resolveProviderParam('codex', ['claude', 'gemini'])).toEqual({
      provider: 'claude',
      param: 'claude',
    });
    expect(resolveProviderParam('codex', [])).toEqual({ provider: '', param: null });
    expect(resolveProviderParam('unknown', ['claude'])).toEqual({
      provider: 'claude',
      param: 'claude',
    });
  });

  test('while credentials load the request stands; no request shows the first without a param', () => {
    expect(resolveProviderParam('grok', undefined)).toEqual({ provider: 'xai', param: 'xai' });
    expect(resolveProviderParam(null, undefined)).toEqual({ provider: '', param: null });
    expect(resolveProviderParam(null, ['claude', 'xai'])).toEqual({
      provider: 'claude',
      param: null,
    });
  });
});

describe('Rules tab list link', () => {
  const accounts = [...inventory().accounts, runtimeAccount('key-1', ['claude-opus-4-5'])];

  test('an existing credential file keeps its list', () => {
    expect(resolveListKey('account:team-b.json', accounts)).toBe('account:team-b.json');
    expect(resolveListKey(null, accounts)).toBe('provider');
  });

  test('a removed account, a runtime credential or garbage falls back to the provider list', () => {
    expect(resolveListKey('account:gone.json', accounts)).toBe('provider');
    expect(resolveListKey('account:key-1', accounts)).toBe('provider');
    expect(resolveListKey('nonsense', accounts)).toBe('provider');
  });

  test('the saved-list signature ignores order and padding, not content', () => {
    expect(listSignature(['b', ' a '])).toBe(listSignature(['a', 'b']));
    expect(listSignature(['a', ''])).toBe(listSignature(['a']));
    expect(listSignature(['a'])).not.toBe(listSignature(['a', 'c']));
    expect(listSignature(['A'])).not.toBe(listSignature(['a']));
  });
});

describe('row action', () => {
  const row = (rows: ReturnType<typeof buildMatrix>, model: string) =>
    rows.find((item) => item.model === model)!;

  test('a served model is excluded everywhere', () => {
    expect(rowActionFor(row(rows, 'claude-opus-4-5'))).toEqual({ kind: 'exclude' });
  });

  test('a model held back only by a provider wildcard offers to edit that rule', () => {
    expect(rowActionFor(row(rows, 'claude-3-7-sonnet'))).toEqual({
      kind: 'edit-rule',
      target: { kind: 'provider' },
    });
  });

  test("a wildcard in an account's own list opens that account's list", () => {
    const own = buildMatrix(
      inventory({ providerList: [], accounts: [account('team-b.json', ['claude-3-*'], {}, [])] })
    );
    expect(rowActionFor(row(own, 'claude-3-5-haiku'))).toEqual({
      kind: 'edit-rule',
      target: { kind: 'account', name: 'team-b.json' },
    });
  });

  test('an exact rule can be removed, so the row offers include everywhere', () => {
    const exact = buildMatrix(
      inventory({
        providerList: ['claude-haiku-4-5'],
        accounts: [account('team-a.json', null, {}, ['claude-haiku-4-5'])],
      })
    );
    expect(rowActionFor(row(exact, 'claude-haiku-4-5'))).toEqual({ kind: 'include' });
  });
});

describe('account identity', () => {
  test('labels two accounts share are reported, so their columns show the file name', () => {
    const twin = { ...account('team-a.json', null), name: 'team-a-2.json' };
    expect([...sharedLabels([...inventory().accounts, twin])]).toEqual(['team-a@example.invalid']);
    expect(sharedLabels(inventory().accounts).size).toBe(0);
  });
});

describe('Models screen wiring', () => {
  const page = readFileSync('src/features/authFiles/models/ModelsPage.tsx', 'utf8');
  const layout = readFileSync('src/components/layout/MainLayout.tsx', 'utf8');

  test('the top bar refresh reloads the screen; it has no refresh button of its own', () => {
    expect(page).toContain('useHeaderRefresh(refresh)');
    expect(page).not.toContain("t('common.refresh')");
  });

  test('the source switcher is the Auth Files pill nav, without "All sources"', () => {
    expect(page).toMatch(/<AuthFilesSourceNav[\s\S]*?showAll=\{false\}/);
    // Neither Models nor its alias editor gets the boxed runtime switcher any more.
    expect(layout).toMatch(/\['\/oauth', '\/config', '\/logs', '\/system'\]\.includes\(/);
  });

  test('the sidebar links the screen after Auth Files', () => {
    expect(layout).toMatch(
      /path: '\/auth-files',[\s\S]*?path: '\/auth-files\/models',\s*labelKey: 'nav.models'/
    );
    expect(layout).toContain('isShadowedByChild');
  });
});
