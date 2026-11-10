import { describe, expect, test } from 'bun:test';
import {
  buildMatrix,
  isAccountEditable,
  isCellToggleable,
  modelUnion,
  resolveCell,
  resolveProviderCell,
  type AccountAccess,
  type CellState,
} from '../src/features/authFiles/modelAccess/resolve';
import { account, inventory, PROVIDER_LIST, runtimeAccount } from './fixtures/modelAccess';

describe('resolveCell: every effective state with its reason', () => {
  const inheriting = account('a.json', null);
  const ownList = account('b.json', ['claude-3-*', 'claude-opus-4-1']);
  const cases: Array<[string, AccountAccess, string, CellState]> = [
    [
      'inheriting, no rule matches',
      inheriting,
      'claude-opus-4-5',
      { kind: 'served', via: 'provider' },
    ],
    [
      'inheriting, exact provider rule',
      inheriting,
      'claude-sonnet-4-0',
      { kind: 'excluded-provider', rule: 'claude-sonnet-4-0', drift: false },
    ],
    [
      'inheriting, provider wildcard is locked',
      inheriting,
      'claude-3-7-sonnet',
      { kind: 'wildcard', rule: 'claude-3-*', list: 'provider', drift: false },
    ],
    // Replace rule: the provider's exact rule does not apply to an account with its own list.
    [
      'own list ignores the provider list',
      ownList,
      'claude-sonnet-4-0',
      { kind: 'served', via: 'account' },
    ],
    [
      'own list, exact rule',
      ownList,
      'claude-opus-4-1',
      { kind: 'excluded-own', rule: 'claude-opus-4-1', drift: false },
    ],
    [
      'own list, own wildcard is locked',
      ownList,
      'claude-3-5-haiku',
      { kind: 'wildcard', rule: 'claude-3-*', list: 'account', drift: false },
    ],
    [
      'disabled account',
      account('c.json', null, { disabled: true }),
      'claude-opus-4-5',
      { kind: 'disabled' },
    ],
    [
      'no rule, but the hub does not report it',
      account('d.json', null, { noAccess: ['claude-opus-4-5'] }),
      'claude-opus-4-5',
      { kind: 'no-access' },
    ],
    [
      'own list unreadable',
      { ...inheriting, ownList: { status: 'unknown', message: 'download failed' } },
      'claude-opus-4-5',
      { kind: 'unknown' },
    ],
    [
      'models unreadable and no rule decides',
      { ...inheriting, reported: { status: 'unknown', message: '500' } },
      'claude-opus-4-5',
      { kind: 'unknown' },
    ],
    [
      'models unreadable but a rule decides',
      { ...inheriting, reported: { status: 'unknown', message: '500' } },
      'claude-sonnet-4-0',
      { kind: 'excluded-provider', rule: 'claude-sonnet-4-0', drift: false },
    ],
    [
      'drift: the lists exclude a model the hub still reports',
      { ...inheriting, reported: { status: 'known', ids: ['claude-sonnet-4-0'] } },
      'claude-sonnet-4-0',
      { kind: 'excluded-provider', rule: 'claude-sonnet-4-0', drift: true },
    ],
    [
      'drift: the hub registered models before the provider wildcard was added',
      account('e.json', null, {}, []),
      'claude-3-5-haiku',
      { kind: 'wildcard', rule: 'claude-3-*', list: 'provider', drift: true },
    ],
  ];
  for (const [name, acc, model, expected] of cases) {
    test(name, () => expect(resolveCell(PROVIDER_LIST, acc, model)).toEqual(expected));
  }

  test('with an empty provider list an inheriting account is served via none', () => {
    expect(resolveCell([], account('e.json', null, {}, []), 'claude-3-5-haiku')).toEqual({
      kind: 'served',
      via: 'none',
    });
  });

  test('only served and exact exclusions are toggleable', () => {
    expect(isCellToggleable({ kind: 'served', via: 'provider' })).toBe(true);
    expect(isCellToggleable({ kind: 'excluded-own', rule: 'x', drift: false })).toBe(true);
    expect(isCellToggleable({ kind: 'excluded-provider', rule: 'x', drift: false })).toBe(true);
    for (const cell of [
      { kind: 'wildcard', rule: 'x*', list: 'provider', drift: false },
      { kind: 'disabled' },
      { kind: 'no-access' },
      { kind: 'unknown' },
    ] as CellState[]) {
      expect(isCellToggleable(cell)).toBe(false);
    }
  });
});

describe('provider column', () => {
  test('exact, wildcard and none', () => {
    expect(resolveProviderCell(PROVIDER_LIST, 'claude-sonnet-4-0')).toEqual({
      excluded: true,
      rule: 'claude-sonnet-4-0',
      wildcard: false,
    });
    expect(resolveProviderCell(PROVIDER_LIST, 'claude-3-7-sonnet')).toEqual({
      excluded: true,
      rule: 'claude-3-*',
      wildcard: true,
    });
    expect(resolveProviderCell(PROVIDER_LIST, 'claude-opus-4-5')).toEqual({ excluded: false });
  });
});

describe('matrix', () => {
  test('rows: catalog order, then reported extras, then rule-only exact ids', () => {
    const inv = inventory({ providerList: [...PROVIDER_LIST, 'claude-retired-1'] });
    expect(modelUnion(inv)).toEqual([
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
      'claude-sonnet-4-0',
      'claude-haiku-4-5',
      'claude-3-7-sonnet',
      'claude-3-5-haiku',
      'claude-preview-x',
      'claude-retired-1',
    ]);
  });

  test('servedBy and the single-account case', () => {
    const rows = new Map(buildMatrix(inventory()).map((row) => [row.model, row]));
    // claude-opus-4-5: team-a serves it; team-b's own list does not exclude it; max-d lacks access.
    expect(rows.get('claude-opus-4-5')!.servedBy).toEqual(['team-a.json', 'team-b.json']);
    // claude-sonnet-4-0: only team-b (own list) serves it; the provider list excludes it elsewhere.
    expect(rows.get('claude-sonnet-4-0')!.servedBy).toEqual(['team-b.json']);
    expect(rows.get('claude-preview-x')!.inCatalog).toBe(false);
    expect(rows.get('claude-opus-4-5')!.aliases).toEqual(['opus']);
    expect(rows.get('claude-3-7-sonnet')!.servedBy).toEqual([]);
  });
});

describe('runtime credentials (held in memory, no file)', () => {
  const channel = runtimeAccount('runtime:1', ['claude-opus-4-5']);

  test('it follows the provider list like any account without a list of its own', () => {
    expect(resolveCell(PROVIDER_LIST, channel, 'claude-opus-4-5')).toEqual({
      kind: 'served',
      via: 'provider',
    });
    expect(resolveCell(PROVIDER_LIST, channel, 'claude-sonnet-4-0')).toEqual({
      kind: 'excluded-provider',
      rule: 'claude-sonnet-4-0',
      drift: false,
    });
    expect(resolveCell(PROVIDER_LIST, channel, 'claude-3-7-sonnet')).toEqual({
      kind: 'wildcard',
      rule: 'claude-3-*',
      list: 'provider',
      drift: false,
    });
    expect(resolveCell(PROVIDER_LIST, channel, 'claude-haiku-4-5')).toEqual({ kind: 'no-access' });
  });

  test('disabled and unreadable runtime credentials', () => {
    expect(resolveCell([], runtimeAccount('k', ['m'], true), 'm')).toEqual({ kind: 'disabled' });
    expect(
      resolveCell([], { ...channel, reported: { status: 'unknown', message: '500' } }, 'm')
    ).toEqual({ kind: 'unknown' });
  });

  test('it counts as serving the model, and its column is read-only', () => {
    const base = inventory({ providerList: [] });
    const rows = buildMatrix({
      ...base,
      accounts: [runtimeAccount('runtime:1', ['claude-3-7-sonnet'])],
    });
    const row = rows.find((item) => item.model === 'claude-3-7-sonnet')!;
    expect(row.servedBy).toEqual(['runtime:1']);
    // The cell kind is toggleable in general; having no file is what makes the column read-only.
    expect(isCellToggleable(row.cells['runtime:1'])).toBe(true);
    expect(isAccountEditable(channel)).toBe(false);
  });
});
