import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_LIST_POLICY,
  blockingRule,
  followsProviderList,
  rulesInEffect,
  sameRuleSet,
} from '../src/features/authFiles/modelAccess/accessRule';

// The backend rule (CLIProxyAPI v8.0.44 sdk/cliproxy/service_models.go:74-82, helpers.go:54-86):
// a NON-EMPTY account list replaces the provider list; missing, empty or blank lists inherit it.
const PROVIDER = ['claude-3-*', 'claude-sonnet-4-0'];

describe('account list replaces the provider list', () => {
  test('the policy constant says replace', () => {
    expect(ACCOUNT_LIST_POLICY).toBe('replace');
  });

  const cases: Array<{
    name: string;
    provider: string[];
    own: string[] | null | undefined;
    source: 'account' | 'provider' | 'none';
    rules: string[];
  }> = [
    {
      name: 'no own list inherits',
      provider: PROVIDER,
      own: null,
      source: 'provider',
      rules: PROVIDER,
    },
    {
      name: 'missing own list inherits',
      provider: PROVIDER,
      own: undefined,
      source: 'provider',
      rules: PROVIDER,
    },
    {
      name: 'empty own list still inherits',
      provider: PROVIDER,
      own: [],
      source: 'provider',
      rules: PROVIDER,
    },
    {
      name: 'blank own list still inherits',
      provider: PROVIDER,
      own: [' ', '\t'],
      source: 'provider',
      rules: PROVIDER,
    },
    {
      name: 'one own entry replaces the whole provider list',
      provider: PROVIDER,
      own: ['claude-opus-4-1'],
      source: 'account',
      rules: ['claude-opus-4-1'],
    },
    {
      name: 'own list is not merged with the provider list',
      provider: PROVIDER,
      own: ['claude-3-*'],
      source: 'account',
      rules: ['claude-3-*'],
    },
    { name: 'no lists at all', provider: [], own: null, source: 'none', rules: [] },
    {
      name: 'own list with empty provider list',
      provider: [],
      own: ['x'],
      source: 'account',
      rules: ['x'],
    },
    {
      name: 'own list is trimmed and deduplicated case-insensitively',
      provider: PROVIDER,
      own: [' A ', 'a', 'b'],
      source: 'account',
      rules: ['A', 'b'],
    },
  ];
  for (const item of cases) {
    test(item.name, () => {
      expect(rulesInEffect(item.provider, item.own)).toEqual({
        source: item.source,
        rules: item.rules,
      });
      expect(followsProviderList(item.own)).toBe(item.source !== 'account');
    });
  }
});

describe('blockingRule matches like the backend', () => {
  const cases: Array<[string[], string, ReturnType<typeof blockingRule>]> = [
    [['claude-3-*'], 'claude-3-7-sonnet', { rule: 'claude-3-*', wildcard: true }],
    [['claude-3-*'], 'claude-3-', { rule: 'claude-3-*', wildcard: true }],
    [['CLAUDE-3-*'], 'claude-3-5-haiku', { rule: 'CLAUDE-3-*', wildcard: true }],
    [['*-haiku'], 'claude-3-5-haiku', { rule: '*-haiku', wildcard: true }],
    [['claude-*-haiku'], 'claude-3-5-haiku', { rule: 'claude-*-haiku', wildcard: true }],
    [['gpt-5.4'], 'gpt-5x4', null],
    [['gpt-5.4'], 'GPT-5.4', { rule: 'gpt-5.4', wildcard: false }],
    [['claude-opus-4-1'], 'claude-opus-4-1-preview', null],
    [['*'], 'anything', { rule: '*', wildcard: true }],
    [[], 'claude-opus-4-5', null],
    // A wildcard wins over an exact rule: removing the exact rule would not serve the model.
    [
      ['claude-3-7-sonnet', 'claude-3-*'],
      'claude-3-7-sonnet',
      { rule: 'claude-3-*', wildcard: true },
    ],
  ];
  for (const [rules, model, expected] of cases) {
    test(`${JSON.stringify(rules)} on ${model}`, () => {
      expect(blockingRule(rules, model)).toEqual(expected);
    });
  }
});

describe('sameRuleSet', () => {
  test('null and empty are the same list', () => expect(sameRuleSet(null, [])).toBe(true));
  test('order and case do not matter', () =>
    expect(sameRuleSet(['A', 'b'], ['B', 'a'])).toBe(true));
  test('a different rule matters', () => expect(sameRuleSet(['a'], ['a', 'b'])).toBe(false));
});
