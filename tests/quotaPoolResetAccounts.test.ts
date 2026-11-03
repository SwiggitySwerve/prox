import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { findPoolResetFile, poolResetReasonKey } from '../src/features/quotaPool/resetAccounts';
import type { AuthFileItem } from '../src/types';

const id = (source: string, provider: string, index: string) =>
  `${source}:${provider}:${createHash('sha256').update(`${provider}\0${index}`).digest('hex')}`;
const file = (index: unknown, provider = 'codex') =>
  ({ name: 'fixture.json', auth_index: index, type: provider }) as AuthFileItem;

describe('pool reset credential matching', () => {
  test('matches the server SHA-256 identity for each provider and source', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const credential = file('42', provider);
      expect(
        findPoolResetFile([credential], 'source-a', provider, id('source-a', provider, '42'))
      ).toBe(credential);
      expect(
        findPoolResetFile([credential], 'source-b', provider, id('source-a', provider, '42'))
      ).toBeUndefined();
    }
  });
  test('normalizes numeric and camelCase indices without matching names', () => {
    const credential = { name: 'different.json', provider: 'codex', authIndex: 42 } as AuthFileItem;
    expect(findPoolResetFile([credential], 's', 'codex', id('s', 'codex', '42'))).toBe(credential);
    expect(findPoolResetFile([file(' 42 ')], 's', 'codex', id('s', 'codex', '42'))).toBeDefined();
  });
  test('rejects missing indices, wrong providers and ambiguous credentials', () => {
    const account = id('s', 'codex', '42');
    expect(findPoolResetFile([file(null)], 's', 'codex', account)).toBeUndefined();
    expect(
      findPoolResetFile([{ ...file('42'), provider: 'claude' }], 's', 'codex', account)
    ).toBeUndefined();
    expect(findPoolResetFile([file('42', 'claude')], 's', 'codex', account)).toBeUndefined();
    expect(findPoolResetFile([file('42'), file('42')], 's', 'codex', account)).toBeUndefined();
  });
});

describe('pool reset disabled reasons', () => {
  test('maps each blocker to a visible translated reason', () => {
    for (const blocker of ['not_limited', 'cooldown', 'paused', 'not_applicable'] as const) {
      expect(poolResetReasonKey(blocker)).toBe(`quota_pool.reset_${blocker}`);
    }
    expect(poolResetReasonKey('ineligible:organization')).toBe('quota_pool.reset_ineligible');
    expect(poolResetReasonKey('ineligible:unknown')).toBe('quota_pool.reset_ineligible');
    expect(poolResetReasonKey(null)).toBe('quota_pool.reset_unavailable');
  });
});
