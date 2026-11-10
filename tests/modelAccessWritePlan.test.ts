import { describe, expect, test } from 'bun:test';
import {
  buildWritePlan,
  InheritChoiceRequiredError,
  ReadOnlyAccountError,
  needsInheritChoice,
  type WritePlan,
} from '../src/features/authFiles/modelAccess/writePlan';
import { account, inventory, PROVIDER_LIST, runtimeAccount } from './fixtures/modelAccess';

const writesOf = (plan: WritePlan) =>
  plan.writes.map((write) => ({
    target: write.target.kind === 'provider' ? 'provider' : write.target.name,
    before: write.before,
    after: write.after,
  }));
const codes = (plan: WritePlan) => plan.notices.map((notice) => notice.code);

describe('(a) one model on one account', () => {
  test('an inheriting account requires the provider-or-own choice; never an implicit own list', () => {
    const inv = inventory();
    const intent = {
      type: 'account-model',
      account: 'team-a.json',
      model: 'claude-opus-4-5',
      exclude: true,
    } as const;
    expect(needsInheritChoice(inv, intent)).toBe(true);
    expect(() => buildWritePlan(inv, intent)).toThrow(InheritChoiceRequiredError);
  });

  test('an account with its own list does not need the choice', () => {
    expect(
      needsInheritChoice(inventory(), {
        type: 'account-model',
        account: 'team-b.json',
        model: 'claude-opus-4-5',
        exclude: true,
      })
    ).toBe(false);
  });

  test("mode 'provider' edits the provider list and names who follows and who ignores it", () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-a.json',
      model: 'claude-opus-4-5',
      exclude: true,
      mode: 'provider',
    });
    expect(writesOf(plan)).toEqual([
      { target: 'provider', before: PROVIDER_LIST, after: [...PROVIDER_LIST, 'claude-opus-4-5'] },
    ]);
    expect(plan.notices).toContainEqual({
      code: 'provider-affects',
      accounts: ['team-a.json', 'pro-c.json', 'max-d.json'],
    });
    expect(plan.notices).toContainEqual({ code: 'provider-ignored-by', accounts: ['team-b.json'] });
    expect(plan.canApply).toBe(true);
    // team-b keeps serving it: the replace rule. max-d had no access; now a rule names why.
    expect(plan.changes).toEqual([
      { account: 'team-a.json', model: 'claude-opus-4-5', from: 'served', to: 'excluded-provider' },
      {
        account: 'max-d.json',
        model: 'claude-opus-4-5',
        from: 'no-access',
        to: 'excluded-provider',
      },
    ]);
  });

  test("mode 'own' copies the provider list plus the change and stops inheriting", () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-a.json',
      model: 'claude-opus-4-5',
      exclude: true,
      mode: 'own',
    });
    expect(writesOf(plan)).toEqual([
      { target: 'team-a.json', before: null, after: [...PROVIDER_LIST, 'claude-opus-4-5'] },
    ]);
    expect(codes(plan)).toEqual(['stops-inheriting']);
  });

  test("mode 'own' to serve a provider-excluded model on one account only", () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-a.json',
      model: 'claude-sonnet-4-0',
      exclude: false,
      mode: 'own',
    });
    expect(writesOf(plan)).toEqual([
      { target: 'team-a.json', before: null, after: ['claude-3-*'] },
    ]);
    expect(plan.changes).toContainEqual({
      account: 'team-a.json',
      model: 'claude-sonnet-4-0',
      from: 'excluded-provider',
      to: 'served',
    });
  });

  test("mode 'own' cannot serve a model when the copy would be empty (empty = inherit)", () => {
    const inv = inventory({ providerList: ['claude-sonnet-4-0'] });
    const plan = buildWritePlan(inv, {
      type: 'account-model',
      account: 'team-a.json',
      model: 'claude-sonnet-4-0',
      exclude: false,
      mode: 'own',
    });
    expect(plan.writes).toEqual([]);
    expect(codes(plan)).toEqual(['cannot-override-provider']);
    expect(plan.canApply).toBe(false);
  });

  test('own list: add an exact rule', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-b.json',
      model: 'claude-haiku-4-5',
      exclude: true,
    });
    expect(writesOf(plan)).toEqual([
      {
        target: 'team-b.json',
        before: ['claude-3-*', 'claude-opus-4-1'],
        after: ['claude-3-*', 'claude-opus-4-1', 'claude-haiku-4-5'],
      },
    ]);
  });

  test('own list: removing the exact rule serves the model again', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-b.json',
      model: 'claude-opus-4-1',
      exclude: false,
    });
    expect(writesOf(plan)).toEqual([
      { target: 'team-b.json', before: ['claude-3-*', 'claude-opus-4-1'], after: ['claude-3-*'] },
    ]);
  });

  test('own list: removing the last entry warns that the account inherits again', () => {
    const inv = inventory({
      accounts: [account('solo.json', ['claude-opus-4-1'])],
    });
    const plan = buildWritePlan(inv, {
      type: 'account-model',
      account: 'solo.json',
      model: 'claude-opus-4-1',
      exclude: false,
    });
    expect(writesOf(plan)).toEqual([
      { target: 'solo.json', before: ['claude-opus-4-1'], after: null },
    ]);
    expect(plan.notices[0]).toMatchObject({ code: 'starts-inheriting', account: 'solo.json' });
    // The preview shows that the provider list now hides models this account used to serve.
    expect(plan.changes).toContainEqual({
      account: 'solo.json',
      model: 'claude-sonnet-4-0',
      from: 'served',
      to: 'excluded-provider',
    });
  });

  test('a model locked by a wildcard is blocked, not written', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-b.json',
      model: 'claude-3-7-sonnet',
      exclude: false,
    });
    expect(plan.writes).toEqual([]);
    expect(plan.blocked).toEqual([
      { target: { kind: 'account', name: 'team-b.json' }, rule: 'claude-3-*' },
    ]);
    expect(plan.canApply).toBe(false);
  });

  test('excluding an already excluded model is a no-op', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-model',
      account: 'team-b.json',
      model: 'claude-opus-4-1',
      exclude: true,
    });
    expect(plan.writes).toEqual([]);
    expect(codes(plan)).toEqual(['no-change']);
  });
});

describe('(b) one model on every account of the provider', () => {
  test('disable everywhere writes every own list and the provider list', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'model-everywhere',
      model: 'claude-haiku-4-5',
      exclude: true,
    });
    expect(writesOf(plan)).toEqual([
      {
        target: 'team-b.json',
        before: ['claude-3-*', 'claude-opus-4-1'],
        after: ['claude-3-*', 'claude-opus-4-1', 'claude-haiku-4-5'],
      },
      { target: 'provider', before: PROVIDER_LIST, after: [...PROVIDER_LIST, 'claude-haiku-4-5'] },
    ]);
    // No account still serves it afterwards.
    expect(plan.changes.map((change) => change.to)).not.toContain('served');
    expect(plan.changes.map((change) => change.account).sort()).toEqual([
      'max-d.json',
      'team-a.json',
      'team-b.json',
    ]);
  });

  test('enable everywhere removes exact rules and reports wildcard locks', () => {
    const inv = inventory({
      providerList: ['claude-3-7-sonnet', 'claude-sonnet-4-0'],
      accounts: [
        account('team-a.json', null, {}, ['claude-3-7-sonnet']),
        account('team-b.json', ['claude-3-*']),
      ],
    });
    const plan = buildWritePlan(inv, {
      type: 'model-everywhere',
      model: 'claude-3-7-sonnet',
      exclude: false,
    });
    expect(writesOf(plan)).toEqual([
      {
        target: 'provider',
        before: ['claude-3-7-sonnet', 'claude-sonnet-4-0'],
        after: ['claude-sonnet-4-0'],
      },
    ]);
    expect(plan.blocked).toEqual([
      { target: { kind: 'account', name: 'team-b.json' }, rule: 'claude-3-*' },
    ]);
    expect(plan.canApply).toBe(true);
  });

  test('an unreadable account list makes the plan unsafe to apply', () => {
    const inv = inventory();
    inv.accounts[0] = {
      ...inv.accounts[0],
      ownList: { status: 'unknown', message: 'download failed' },
    };
    const plan = buildWritePlan(inv, {
      type: 'model-everywhere',
      model: 'claude-haiku-4-5',
      exclude: true,
    });
    expect(plan.notices).toContainEqual({ code: 'unreadable', accounts: ['team-a.json'] });
    expect(plan.canApply).toBe(false);
  });

  test('removing the provider list entirely writes null', () => {
    const inv = inventory({
      providerList: ['claude-sonnet-4-0'],
      accounts: [account('a.json', null, {}, ['claude-sonnet-4-0'])],
    });
    const plan = buildWritePlan(inv, {
      type: 'model-everywhere',
      model: 'claude-sonnet-4-0',
      exclude: false,
    });
    expect(writesOf(plan)).toEqual([
      { target: 'provider', before: ['claude-sonnet-4-0'], after: null },
    ]);
  });
});

describe('(c) one account across every model', () => {
  test('exclude all gives the account a list of every known model', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-all',
      account: 'team-a.json',
      exclude: true,
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].after).toContain('claude-opus-4-5');
    expect(plan.writes[0].after).toContain('claude-preview-x');
    expect(codes(plan)).toEqual(['stops-inheriting']);
    expect(plan.changes.filter((change) => change.to === 'served')).toEqual([]);
  });

  test('include all clears the own list and shows what the provider list still excludes', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-all',
      account: 'team-b.json',
      exclude: false,
    });
    expect(writesOf(plan)).toEqual([
      { target: 'team-b.json', before: ['claude-3-*', 'claude-opus-4-1'], after: null },
    ]);
    expect(plan.notices[0]).toMatchObject({
      code: 'starts-inheriting',
      stillExcluded: ['claude-sonnet-4-0', 'claude-3-7-sonnet', 'claude-3-5-haiku'],
    });
  });

  test('include all on an inheriting account changes nothing', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'account-all',
      account: 'team-a.json',
      exclude: false,
    });
    expect(plan.writes).toEqual([]);
    expect(codes(plan)).toEqual(['no-change']);
  });
});

describe('(d) provider default', () => {
  test('writes only the provider list and names the accounts that will not follow', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'provider-model',
      model: 'claude-haiku-4-5',
      exclude: true,
    });
    expect(writesOf(plan).map((write) => write.target)).toEqual(['provider']);
    expect(plan.notices).toContainEqual({ code: 'provider-ignored-by', accounts: ['team-b.json'] });
  });
});

describe('replace a list', () => {
  test('provider list replaced as edited', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'replace-list',
      target: { kind: 'provider' },
      rules: ['claude-3-*'],
    });
    expect(writesOf(plan)).toEqual([
      { target: 'provider', before: PROVIDER_LIST, after: ['claude-3-*'] },
    ]);
  });

  test('an unchanged list is a no-op', () => {
    const plan = buildWritePlan(inventory(), {
      type: 'replace-list',
      target: { kind: 'provider' },
      rules: ['CLAUDE-SONNET-4-0', 'claude-3-*'],
    });
    expect(plan.writes).toEqual([]);
    expect(plan.canApply).toBe(false);
  });
});

describe('runtime credentials (config API keys) are read-only here', () => {
  const withKey = () => {
    const base = inventory();
    return inventory({
      accounts: [...base.accounts, runtimeAccount('claude:apikey:1', ['claude-haiku-4-5'])],
    });
  };

  test('disable everywhere says which API-key credentials still serve the model', () => {
    const plan = buildWritePlan(withKey(), {
      type: 'model-everywhere',
      model: 'claude-haiku-4-5',
      exclude: true,
    });
    expect(plan.notices).toContainEqual({
      code: 'still-served-by',
      model: 'claude-haiku-4-5',
      accounts: ['claude:apikey:1'],
    });
    // Its exclusions live in its config entry: no write and no claimed change for it.
    expect(plan.writes.map((write) => write.target)).not.toContainEqual({
      kind: 'account',
      name: 'claude:apikey:1',
    });
    expect(plan.changes.map((change) => change.account)).not.toContain('claude:apikey:1');
    expect(plan.canApply).toBe(true);
  });

  test('no notice when the API-key credential does not serve the model', () => {
    const plan = buildWritePlan(withKey(), {
      type: 'model-everywhere',
      model: 'claude-opus-4-5',
      exclude: true,
    });
    expect(codes(plan)).not.toContain('still-served-by');
  });

  test('a provider-list change never lists an API-key credential as following it', () => {
    const plan = buildWritePlan(withKey(), {
      type: 'provider-model',
      model: 'claude-opus-4-5',
      exclude: true,
    });
    const affects = plan.notices.find((notice) => notice.code === 'provider-affects');
    expect(affects).toEqual({
      code: 'provider-affects',
      accounts: ['team-a.json', 'pro-c.json', 'max-d.json'],
    });
  });

  test('a toggle on an API-key credential is refused, never planned', () => {
    expect(() =>
      buildWritePlan(withKey(), {
        type: 'account-model',
        account: 'claude:apikey:1',
        model: 'claude-haiku-4-5',
        exclude: true,
        mode: 'own',
      })
    ).toThrow(ReadOnlyAccountError);
    expect(() =>
      buildWritePlan(withKey(), { type: 'account-all', account: 'claude:apikey:1', exclude: true })
    ).toThrow(ReadOnlyAccountError);
  });
});
