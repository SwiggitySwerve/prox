import { describe, expect, test } from 'bun:test';
import {
  accessCell,
  pendingAccessChanges,
  planAccessWrites,
  pruneOverrides,
  stageAccess,
  type AccessChange,
  type AccessOverrides,
  type AccessPlan,
} from '../src/features/authFiles/modelAccess/accessDraft';
import type { ModelAccessInventory } from '../src/features/authFiles/modelAccess/resolve';
import { account, CATALOG, inventory, PROVIDER_LIST, runtimeAccount } from './fixtures/modelAccess';

/**
 * The fixture hub (tests/fixtures/modelAccess.ts): provider list ['claude-3-*', 'claude-sonnet-4-0'];
 * team-a follows it; team-b has its own list ['claude-3-*', 'claude-opus-4-1']; pro-c is off and
 * follows it; max-d follows it and cannot get claude-opus-4-5.
 */
const writesOf = (plan: AccessPlan) =>
  plan.status === 'ready'
    ? plan.writes.map((write) => ({
        target: write.target.kind === 'provider' ? 'provider' : write.target.name,
        before: write.before,
        after: write.after,
      }))
    : plan;

const stage = (inv: ModelAccessInventory, changes: AccessChange[], from: AccessOverrides = {}) =>
  stageAccess(inv, from, changes);

/** The column switch: one model, every account of the provider. */
const column = (inv: ModelAccessInventory, model: string, on: boolean): AccessChange[] =>
  inv.accounts.map((item) => ({ account: item.name, model, on }));

/** The row switch: every model, one account. */
const row = (inv: ModelAccessInventory, name: string, on: boolean): AccessChange[] =>
  [...CATALOG, 'claude-preview-x'].map((model) => ({ account: name, model, on }));

const runtimeInventory = (...runtime: ReturnType<typeof runtimeAccount>[]) => {
  const base = inventory();
  return { ...base, accounts: [...base.accounts, ...runtime] };
};

/** A runtime credential reports what the provider list leaves it (it always follows it). */
const runtimeFollowing = (name: string) =>
  runtimeAccount(
    name,
    CATALOG.filter(
      (id) => !['claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-sonnet-4-0'].includes(id)
    )
  );

describe('cells', () => {
  test('a model the account can get is a switch; one it cannot get is not', () => {
    const inv = inventory();
    const maxD = inv.accounts[3];
    expect(accessCell(inv, {}, maxD, 'claude-opus-4-1')).toEqual({
      kind: 'switch',
      on: true,
      changed: false,
    });
    // Blocked by the shared list: still a switch, off.
    expect(accessCell(inv, {}, maxD, 'claude-3-7-sonnet')).toEqual({
      kind: 'switch',
      on: false,
      changed: false,
    });
    // Not offered to max-d at all.
    expect(accessCell(inv, {}, maxD, 'claude-opus-4-5')).toEqual({ kind: 'none' });
  });

  test('a disabled account keeps switches for every model', () => {
    const inv = inventory();
    const proC = inv.accounts[2];
    expect(accessCell(inv, {}, proC, 'claude-opus-4-5')).toMatchObject({
      kind: 'switch',
      on: true,
    });
    expect(accessCell(inv, {}, proC, 'claude-3-5-haiku')).toMatchObject({
      kind: 'switch',
      on: false,
    });
  });

  test('an account whose settings could not be read has no switches', () => {
    const inv = inventory();
    const unread = { ...inv.accounts[0], ownList: { status: 'unknown' as const, message: 'x' } };
    expect(accessCell(inv, {}, unread, 'claude-opus-4-5')).toEqual({ kind: 'unknown' });
  });

  test('staging shows the new state as changed; staging it back removes the change', () => {
    const inv = inventory();
    const teamA = inv.accounts[0];
    const off = stage(inv, [{ account: 'team-a.json', model: 'claude-opus-4-5', on: false }]);
    expect(accessCell(inv, off, teamA, 'claude-opus-4-5')).toEqual({
      kind: 'switch',
      on: false,
      changed: true,
    });
    const back = stage(inv, [{ account: 'team-a.json', model: 'claude-opus-4-5', on: true }], off);
    expect(back).toEqual({});
    expect(planAccessWrites(inv, back)).toEqual({ status: 'none' });
  });

  test('a column change skips cells that are not switches', () => {
    const inv = inventory();
    const staged = stage(inv, column(inv, 'claude-opus-4-5', false));
    expect(pendingAccessChanges(inv, staged)).toEqual([
      { account: 'team-a.json', model: 'claude-opus-4-5', on: false },
      { account: 'team-b.json', model: 'claude-opus-4-5', on: false },
      { account: 'pro-c.json', model: 'claude-opus-4-5', on: false },
    ]);
  });
});

describe('the writes Prox computes', () => {
  test('column off reaches the account that has its own list', () => {
    const inv = inventory();
    const plan = planAccessWrites(inv, stage(inv, column(inv, 'claude-haiku-4-5', false)));
    expect(writesOf(plan)).toEqual([
      {
        target: 'provider',
        before: PROVIDER_LIST,
        after: [...PROVIDER_LIST, 'claude-haiku-4-5'],
      },
      {
        target: 'team-b.json',
        before: ['claude-3-*', 'claude-opus-4-1'],
        after: ['claude-3-*', 'claude-opus-4-1', 'claude-haiku-4-5'],
      },
    ]);
    // Everything the result depends on but does not write is checked again before writing.
    expect(plan.status === 'ready' && plan.guards).toEqual([
      { target: { kind: 'account', name: 'team-a.json' }, expected: null },
      { target: { kind: 'account', name: 'pro-c.json' }, expected: null },
      { target: { kind: 'account', name: 'max-d.json' }, expected: null },
    ]);
  });

  test('a single cell off gives only that account a list of its own', () => {
    const inv = inventory();
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'team-a.json', model: 'claude-opus-4-5', on: false }])
    );
    expect(writesOf(plan)).toEqual([
      { target: 'team-a.json', before: null, after: [...PROVIDER_LIST, 'claude-opus-4-5'] },
    ]);
    expect(plan.status === 'ready' && plan.guards).toContainEqual({
      target: { kind: 'provider' },
      expected: PROVIDER_LIST,
    });
  });

  test('turning an account back to match the others clears its own list', () => {
    const inv = inventory({
      accounts: [
        account('team-a.json', null),
        account('team-b.json', [...PROVIDER_LIST, 'claude-opus-4-1']),
      ],
    });
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'team-b.json', model: 'claude-opus-4-1', on: true }])
    );
    expect(writesOf(plan)).toEqual([
      { target: 'team-b.json', before: [...PROVIDER_LIST, 'claude-opus-4-1'], after: null },
    ]);
  });

  test('an untouched account whose list already matches is left alone', () => {
    const inv = inventory({
      accounts: [account('team-a.json', null), account('team-b.json', [...PROVIDER_LIST])],
    });
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'team-a.json', model: 'claude-opus-4-5', on: false }])
    );
    expect(writesOf(plan)).toEqual([
      { target: 'team-a.json', before: null, after: [...PROVIDER_LIST, 'claude-opus-4-5'] },
    ]);
  });

  test('turning on a model a wildcard covers replaces that wildcard with its other matches', () => {
    const inv = inventory();
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'team-a.json', model: 'claude-3-7-sonnet', on: true }])
    );
    expect(writesOf(plan)).toEqual([
      { target: 'team-a.json', before: null, after: ['claude-3-5-haiku', 'claude-sonnet-4-0'] },
    ]);
    expect(plan.status === 'ready' && plan.expansions).toEqual([
      {
        target: { kind: 'account', name: 'team-a.json' },
        rule: 'claude-3-*',
        replacedBy: ['claude-3-5-haiku'],
        unblocked: ['claude-3-7-sonnet'],
      },
    ]);
  });

  test('a wildcard whose matches all stay off is kept', () => {
    const inv = inventory();
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'team-b.json', model: 'claude-opus-4-1', on: true }])
    );
    expect(writesOf(plan)).toEqual([
      {
        target: 'team-b.json',
        before: ['claude-3-*', 'claude-opus-4-1'],
        after: ['claude-3-*'],
      },
    ]);
    expect(plan.status === 'ready' && plan.expansions).toEqual([]);
  });

  test('a column on under a shared wildcard expands it in each list that has it', () => {
    const inv = inventory();
    const plan = planAccessWrites(inv, stage(inv, column(inv, 'claude-3-7-sonnet', true)));
    expect(writesOf(plan)).toEqual([
      {
        target: 'provider',
        before: PROVIDER_LIST,
        after: ['claude-3-5-haiku', 'claude-sonnet-4-0'],
      },
      {
        target: 'team-b.json',
        before: ['claude-3-*', 'claude-opus-4-1'],
        after: ['claude-3-5-haiku', 'claude-opus-4-1'],
      },
    ]);
    expect(plan.status === 'ready' && plan.expansions.map((item) => item.target)).toEqual([
      { kind: 'provider' },
      { kind: 'account', name: 'team-b.json' },
    ]);
  });

  test('every model off for one account', () => {
    const inv = inventory();
    const plan = planAccessWrites(inv, stage(inv, row(inv, 'max-d.json', false)));
    // claude-opus-4-5 is not offered to max-d, so it is left to the shared rules.
    expect(writesOf(plan)).toEqual([
      {
        target: 'max-d.json',
        before: null,
        after: [...PROVIDER_LIST, 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
      },
    ]);
  });

  test('every model on for one account, when nothing forces a shared default', () => {
    const inv = inventory();
    const plan = planAccessWrites(inv, stage(inv, row(inv, 'team-a.json', true)));
    // Cheapest: team-a keeps following; the shared rules move to the others that differ now.
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    const after = Object.fromEntries(
      plan.writes.map((write) => [
        write.target.kind === 'provider' ? 'provider' : write.target.name,
        write.after,
      ])
    );
    expect(after.provider).toBeNull();
    expect(after['pro-c.json']).toEqual(PROVIDER_LIST);
    expect(after['max-d.json']).toEqual(PROVIDER_LIST);
    expect('team-a.json' in after).toBe(false);
    expect('team-b.json' in after).toBe(false);
  });
});

describe('the fewest writes', () => {
  test('followers whose switches do not overlap share one provider list', () => {
    // one has its own list [a, b] and reports c; two reports only c; three reports only a and b.
    const file = (name: string, own: string[] | null, ids: string[]) => ({
      name,
      kind: 'file' as const,
      label: name,
      disabled: false,
      ownList: { status: 'known' as const, rules: own },
      reported: { status: 'known' as const, ids },
    });
    const inv: ModelAccessInventory = {
      provider: 'claude',
      providerList: [],
      catalog: ['a', 'b', 'c'],
      aliases: [],
      accounts: [
        file('one', ['a', 'b'], ['c']),
        file('two', null, ['c']),
        file('three', null, ['a', 'b']),
      ],
    };
    const plan = planAccessWrites(
      inv,
      stage(inv, [
        { account: 'one', model: 'b', on: true },
        { account: 'two', model: 'c', on: false },
        { account: 'three', model: 'a', on: false },
        { account: 'three', model: 'b', on: false },
      ])
    );
    expect(writesOf(plan)).toEqual([
      { target: 'provider', before: null, after: ['a', 'b', 'c'] },
      { target: 'one', before: ['a', 'b'], after: ['a'] },
    ]);
  });
});

describe('the fewest writes, exactly', () => {
  test('the largest set of followers that agree keeps the shared list; the rest get lists', () => {
    // Every account follows an empty provider list; reported -> wanted off.
    const wants: Array<[string, string[]]> = [
      ['bcd', ['b', 'd']],
      ['abc', ['a', 'c']],
      ['bcde', ['b', 'd']],
      ['abcde', ['b', 'd']],
      ['d', []],
      ['abce', ['b', 'e']],
      ['b', ['b']],
    ];
    const inv: ModelAccessInventory = {
      provider: 'claude',
      providerList: [],
      catalog: ['a', 'b', 'c', 'd', 'e'],
      aliases: [],
      accounts: wants.map(([ids], index) => ({
        name: `n${index + 1}`,
        kind: 'file' as const,
        label: `n${index + 1}`,
        disabled: false,
        ownList: { status: 'known' as const, rules: null },
        reported: { status: 'known' as const, ids: ids.split('') },
      })),
    };
    const changes = wants.flatMap(([, off], index) =>
      off.map((model) => ({ account: `n${index + 1}`, model, on: false }))
    );
    // n5 wants nothing off, so the shared list cannot block d; n6 and n7 agree with it.
    expect(writesOf(planAccessWrites(inv, stage(inv, changes)))).toEqual([
      { target: 'provider', before: null, after: ['b', 'e'] },
      { target: 'n1', before: null, after: ['b', 'd'] },
      { target: 'n2', before: null, after: ['a', 'c'] },
      { target: 'n3', before: null, after: ['b', 'd'] },
      { target: 'n4', before: null, after: ['b', 'd'] },
    ]);
  });
});

describe('accounts held in memory (no credential file)', () => {
  test('a column change still goes through the shared list they follow', () => {
    const inv = runtimeInventory(runtimeFollowing('rt-1'));
    const plan = planAccessWrites(inv, stage(inv, column(inv, 'claude-haiku-4-5', false)));
    expect(writesOf(plan)).toEqual([
      { target: 'provider', before: PROVIDER_LIST, after: [...PROVIDER_LIST, 'claude-haiku-4-5'] },
      {
        target: 'team-b.json',
        before: ['claude-3-*', 'claude-opus-4-1'],
        after: ['claude-3-*', 'claude-opus-4-1', 'claude-haiku-4-5'],
      },
    ]);
  });

  test('a file account cannot have every model on while one of them has some off', () => {
    const inv = runtimeInventory(runtimeFollowing('rt-1'));
    const plan = planAccessWrites(inv, stage(inv, row(inv, 'team-a.json', true)));
    expect(plan).toEqual({
      status: 'blocked',
      block: { code: 'all-on', account: 'team-a.json', runtime: ['rt-1'] },
    });
  });

  test('two of them cannot differ', () => {
    const inv = runtimeInventory(runtimeFollowing('rt-1'), runtimeFollowing('rt-2'));
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'rt-1', model: 'claude-opus-4-5', on: false }])
    );
    expect(plan).toEqual({
      status: 'blocked',
      block: { code: 'runtime-differ', accounts: ['rt-1', 'rt-2'] },
    });
  });

  test('changing one of them moves the shared list and keeps the others as they were', () => {
    const inv = runtimeInventory(runtimeFollowing('rt-1'));
    const plan = planAccessWrites(
      inv,
      stage(inv, [{ account: 'rt-1', model: 'claude-haiku-4-5', on: false }])
    );
    expect(writesOf(plan)).toEqual([
      { target: 'provider', before: PROVIDER_LIST, after: [...PROVIDER_LIST, 'claude-haiku-4-5'] },
      { target: 'team-a.json', before: null, after: PROVIDER_LIST },
      { target: 'pro-c.json', before: null, after: PROVIDER_LIST },
      { target: 'max-d.json', before: null, after: PROVIDER_LIST },
    ]);
  });
});

describe('safety', () => {
  test('an account whose settings can no longer be read keeps its staged switches, and Save waits', () => {
    const inv = inventory();
    const staged = stage(inv, [{ account: 'team-a.json', model: 'claude-opus-4-5', on: false }]);
    // A failed re-read of a list that was empty leaves no data: the account reads as unknown.
    const lost = {
      ...inv,
      accounts: inv.accounts.map((item) =>
        item.name === 'team-a.json'
          ? { ...item, ownList: { status: 'unknown' as const, message: 'x' } }
          : item
      ),
    };
    expect(pruneOverrides(lost, staged)).toBe(staged);
    expect(pendingAccessChanges(lost, staged)).toEqual([
      { account: 'team-a.json', model: 'claude-opus-4-5', on: false },
    ]);
    expect(planAccessWrites(lost, staged)).toEqual({
      status: 'blocked',
      block: { code: 'unreadable', accounts: ['team-a.json'] },
    });
  });

  test('a change to the shared list is blocked while an account cannot be read', () => {
    const base = inventory();
    const inv = {
      ...base,
      accounts: [
        ...base.accounts,
        { ...account('lost.json', null), ownList: { status: 'unknown' as const, message: 'x' } },
      ],
    };
    expect(planAccessWrites(inv, stage(inv, column(inv, 'claude-haiku-4-5', false)))).toEqual({
      status: 'blocked',
      block: { code: 'unreadable', accounts: ['lost.json'] },
    });
    // A change that leaves the shared list alone is still allowed.
    expect(
      planAccessWrites(
        inv,
        stage(inv, [{ account: 'team-a.json', model: 'claude-opus-4-5', on: false }])
      ).status
    ).toBe('ready');
  });

  test('after a save the re-read lists make the landed changes no-ops; failed ones stay', () => {
    const inv = inventory();
    const staged = stage(inv, column(inv, 'claude-haiku-4-5', false));
    // The provider write landed; team-b's failed.
    const after = inventory({
      providerList: [...PROVIDER_LIST, 'claude-haiku-4-5'],
      accounts: [
        account('team-a.json', null, {}, [...PROVIDER_LIST, 'claude-haiku-4-5']),
        account('team-b.json', ['claude-3-*', 'claude-opus-4-1'], { extra: ['claude-preview-x'] }),
        account('pro-c.json', null, { disabled: true }),
        account('max-d.json', null, { noAccess: ['claude-opus-4-5'] }, [
          ...PROVIDER_LIST,
          'claude-haiku-4-5',
        ]),
      ],
    });
    const left = pruneOverrides(after, staged);
    expect(pendingAccessChanges(after, left)).toEqual([
      { account: 'team-b.json', model: 'claude-haiku-4-5', on: false },
    ]);
    expect(pruneOverrides(after, left)).toBe(left);
  });
});
