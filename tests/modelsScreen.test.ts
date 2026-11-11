import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMatrix, CELL_KINDS } from '../src/features/authFiles/modelAccess/resolve';
import {
  accountListKind,
  cellLabelKey,
  countServed,
  filterAccounts,
  filterRows,
  hubsForProvider,
  legacyModelsTarget,
  listDiff,
  listKeyOf,
  listOwner,
  listSignature,
  providerCountsAcross,
  resolveListKey,
  resolveProviderAcross,
  resolveProviderParam,
  resolveSourceScope,
  sharedDomain,
  sharedLabels,
  summarizeChanges,
  sumCounts,
  targetOfListKey,
  type HubFiles,
} from '../src/features/authFiles/models/matrixView';
import { modelsScreenPath } from '../src/features/authFiles/unifiedList';
import type { AccountAccess } from '../src/features/authFiles/modelAccess';
import type { AuthFileItem } from '../src/types';
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

  test('the Models route handles hubs itself: no single-hub boundary around it', () => {
    const routes = readFileSync('src/router/MainRoutes.tsx', 'utf8');
    expect(routes).toContain("{ path: '/auth-files/models', element: <ModelsPage /> }");
  });

  test('the Models screen exposes its machines to tests and agents', () => {
    const section = readFileSync('src/features/authFiles/models/ModelsHubSection.tsx', 'utf8');
    expect(section).toContain('data-machine="model-inventory"');
    expect(section).toContain('data-machine="model-edit-session"');
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

  test('the hub filter is the Auth Files pill nav with "All sources"; providers are its tabs', () => {
    expect(page).toMatch(/<AuthFilesSourceNav[\s\S]*?active=\{scope \?\? ALL_SOURCES\}/);
    expect(page).not.toContain('showAll={false}');
    expect(page).toMatch(/<ProviderTabs[\s\S]*?placeholders=/);
    // One view switch, with the tab semantics the keyboard check relies on.
    expect(page).toContain('role="tablist"');
    expect(page).toContain('id={`models-tab-${key}`}');
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

const file = (name: string, type: string): AuthFileItem => ({ name, type }) as AuthFileItem;
const HUBS: HubFiles[] = [
  {
    id: 'alpha',
    files: [file('a.json', 'claude'), file('b.json', 'claude'), file('c.json', 'grok')],
  },
  { id: 'beta', files: [file('x.json', 'codex'), file('b.json', 'claude')] },
];

describe('access grid', () => {
  test('the Save bar names a column change once, and a row change as one account', () => {
    const column = ['a.json', 'b.json', 'c.json'].map((name) => ({
      account: name,
      model: 'claude-haiku-4-5',
      on: false,
    }));
    const rowOn = ['claude-opus-4-5', 'claude-opus-4-1'].map((model) => ({
      account: 'd.json',
      model,
      on: true,
    }));
    expect(summarizeChanges([...column, ...rowOn])).toEqual([
      { on: false, models: ['claude-haiku-4-5'], accounts: ['a.json', 'b.json', 'c.json'] },
      { on: true, models: ['claude-opus-4-5', 'claude-opus-4-1'], accounts: ['d.json'] },
    ]);
    expect(summarizeChanges([])).toEqual([]);
  });

  test("the grid never shows the hub's lists: no provider row, groups or list wording", () => {
    const grid = readFileSync('src/features/authFiles/models/ModelAccessMatrix.tsx', 'utf8');
    for (const word of [
      'group_',
      'badge_',
      'provider_cell',
      'column_provider',
      'own list',
      'ListTarget',
    ]) {
      expect(grid).not.toContain(word);
    }
    const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8')).model_access;
    for (const key of Object.keys(en).filter((item) => /^(grid|bar|phone)_/.test(item))) {
      expect(en[key]).not.toMatch(/provider list|own list|follows/i);
    }
  });

  test('models run down the rows, served above not served; accounts across the top', () => {
    const grid = readFileSync('src/features/authFiles/models/ModelAccessMatrix.tsx', 'utf8');
    // One labelled tbody per part, as saved: staging a switch never moves a row.
    expect(grid).toMatch(/<tbody key=\{section\.key\} data-section=\{section\.key\}>/);
    expect(grid.indexOf("key: 'served'")).toBeLessThan(grid.indexOf("key: 'not-served'"));
    expect(grid).toContain('const isServed = (row: MatrixRow) => row.servedBy.length > 0;');
    expect(grid).toContain('data-model-switch={row.model}');
    expect(grid).toContain('data-account-switch={account.name}');
    const scss = readFileSync('src/features/authFiles/models/ModelsPage.module.scss', 'utf8');
    // Columns share the frame; the table only grows past it below --account-min per account.
    expect(scss).toContain(
      'width: max(100%, calc(var(--head-col) + var(--account-min) * var(--account-count, 1)));'
    );
    // ...and each account column stops at --account-max, so switches stay near their models; a
    // last column takes the rest, so rows still reach the frame's edge.
    expect(scss).toContain('width: var(--account-col);');
    expect(scss).toMatch(
      /--account-col: clamp\(\s*var\(--account-min\),[^;]*var\(--account-max\)\s*\);/
    );
    expect(grid).toContain('<td className={styles.fill} aria-hidden="true" />');
  });

  test('the section stages switches and saves from the bar; no dialog for the grid', () => {
    const section = readFileSync('src/features/authFiles/models/ModelsHubSection.tsx', 'utf8');
    expect(section).toContain('useAccessDraft(inventory, io, reload, onChanged)');
    expect(section).toContain('onStage={draft.stage}');
    expect(section).toContain('<AccessSaveBar');
    expect(section).not.toContain('LockedCellDialog');
    const bar = readFileSync('src/features/authFiles/models/AccessSaveBar.tsx', 'utf8');
    expect(bar).toContain('data-machine="model-access-draft"');
    expect(bar).not.toContain('Modal');
    // Docked on <body> (the shell clips the page, so sticky never sticks), only for the visible
    // route: a hidden previous layer must not leave its bar over the next page.
    const page = readFileSync('src/features/authFiles/models/ModelsPage.tsx', 'utf8');
    expect(page).toMatch(/isCurrentLayer &&\s*createPortal\(<div ref=\{setDock\}/);
    expect(section).toContain('createPortal(bar, saveDock)');
  });

  test('the model filter and Served switch narrow columns; the account filter narrows rows', () => {
    const columns = filterRows(rows, 'haiku', 'served').map((row) => row.model);
    expect(columns).toEqual(['claude-haiku-4-5']);
    const visible = filterAccounts(inventory().accounts, 'team');
    expect(visible.map((item) => item.name)).toEqual(['team-a.json', 'team-b.json']);
    expect(
      sumCounts([
        { models: 1, served: 1, accounts: 2 },
        { models: 4, served: 2, accounts: 1 },
      ])
    ).toEqual({ models: 5, served: 3, accounts: 3 });
  });
});

describe('hubs and providers', () => {
  test('provider tabs count credentials on every hub in scope; an unread hub leaves them incomplete', () => {
    expect(providerCountsAcross(HUBS)).toEqual({
      counts: { claude: 3, xai: 1, codex: 1 },
      complete: true,
    });
    expect(providerCountsAcross([...HUBS, { id: 'gamma', files: undefined }]).complete).toBe(false);
  });

  test('a request stands while a hub is unread; otherwise the first provider is shown', () => {
    expect(resolveProviderAcross('gemini', ['claude'], false)).toEqual({
      provider: 'gemini',
      param: 'gemini',
    });
    expect(resolveProviderAcross(null, ['claude'], false)).toEqual({
      provider: 'claude',
      param: null,
    });
    expect(resolveProviderAcross('gemini', ['claude'], true)).toEqual({
      provider: 'claude',
      param: 'claude',
    });
  });

  test('a provider gets one section per hub that has it, plus hubs not read yet', () => {
    expect(hubsForProvider(HUBS, 'claude')).toEqual(['alpha', 'beta']);
    expect(hubsForProvider(HUBS, 'codex')).toEqual(['beta']);
    expect(hubsForProvider([...HUBS, { id: 'gamma', files: undefined }], 'codex')).toEqual([
      'beta',
      'gamma',
    ]);
    expect(hubsForProvider(HUBS, '')).toEqual([]);
  });

  test('?source= is an optional filter: absent, unknown or the only hub means every hub', () => {
    expect(resolveSourceScope(null, ['alpha', 'beta'])).toBeNull();
    expect(resolveSourceScope('beta', ['alpha', 'beta'])).toBe('beta');
    expect(resolveSourceScope('gone', ['alpha', 'beta'])).toBeNull();
    expect(resolveSourceScope('alpha', ['alpha'])).toBeNull();
  });

  test('?list= belongs to the hub ?source= names, else the first hub with that account', () => {
    expect(listOwner('account:b.json', 'beta', HUBS)).toBe('beta');
    expect(listOwner('account:b.json', null, HUBS)).toBe('alpha');
    expect(listOwner('account:x.json', null, HUBS)).toBe('beta');
    expect(listOwner('account:gone.json', null, HUBS)).toBeNull();
    expect(listOwner('provider', null, HUBS)).toBeNull();
    expect(listOwner(null, 'alpha', HUBS)).toBeNull();
  });

  test('a list opened from a hub section stays in that hub, even when another hub has the file', () => {
    // b.json exists on alpha and beta; "Edit rule" in beta's section must not open alpha's list.
    expect(listOwner('account:b.json', null, HUBS, 'beta')).toBe('beta');
    expect(listOwner('provider', null, HUBS, 'beta')).toBe('beta');
    // A hub that is gone falls back to the old lookup.
    expect(listOwner('account:b.json', null, HUBS, 'gone')).toBe('alpha');
    const section = readFileSync('src/features/authFiles/models/ModelsHubSection.tsx', 'utf8');
    expect(section.match(/listHub: hubId/g)).toHaveLength(1);
  });

  test('links built by modelsScreenPath still open the right hub, provider and list', () => {
    const params = new URLSearchParams(modelsScreenPath('beta', 'claude', 'b.json').split('?')[1]);
    const source = params.get('source');
    expect(resolveSourceScope(source, ['alpha', 'beta'])).toBe('beta');
    expect(resolveProviderAcross(params.get('provider'), ['claude'], true).provider).toBe('claude');
    expect(params.get('tab')).toBe('rules');
    expect(listOwner(params.get('list'), source, HUBS)).toBe('beta');
  });
});

describe('shared email domain', () => {
  const labelled = (label: string) => ({ label }) as unknown as AccountAccess;
  test('said once when every email shares it and the names differ', () => {
    expect(
      sharedDomain([labelled('a@x.dev'), labelled('b@x.dev'), labelled('runtime-channel')])
    ).toBe('@x.dev');
  });
  test('kept per column when domains differ, names repeat, or only one email', () => {
    expect(sharedDomain([labelled('a@x.dev'), labelled('b@y.dev')])).toBeNull();
    expect(sharedDomain([labelled('ops@x.dev'), labelled('ops@x.dev')])).toBeNull();
    expect(sharedDomain([labelled('a@x.dev'), labelled('runtime-channel')])).toBeNull();
  });
});
