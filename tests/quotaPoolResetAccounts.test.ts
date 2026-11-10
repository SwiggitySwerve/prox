import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  findPoolResetFile,
  heldExpiries,
  poolResetReasonKey,
  poolResetStatus,
  markSpent,
  wasSpent,
} from '../src/features/quotaPool/resetAccounts';
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
  test('matches only the source-qualified identity, never a legacy row id', () => {
    // A migrated row keeps `${provider}:${digest}` as its id; the server sends its current
    // identity separately, and that is the only form the page accepts.
    const legacy = `claude:${createHash('sha256').update('claude\u00007').digest('hex')}`;
    const credential = file('7', 'claude');
    expect(findPoolResetFile([credential], 'claude-primary', 'claude', legacy)).toBeUndefined();
    expect(
      findPoolResetFile([credential], 'claude-primary', 'claude', `claude-primary:${legacy}`)
    ).toBe(credential);
    expect(findPoolResetFile([credential], 'claude-primary', 'claude', null)).toBeUndefined();
  });
  test('normalizes numeric and camelCase indices without matching names', () => {
    const credential = { name: 'different.json', provider: 'codex', authIndex: 42 } as AuthFileItem;
    expect(findPoolResetFile([credential], 's', 'codex', id('s', 'codex', '42'))).toBe(credential);
    expect(findPoolResetFile([file(' 42 ')], 's', 'codex', id('s', 'codex', '42'))).toBeDefined();
  });
  test('reads the provider the way every other screen does, ignoring case and spelling', () => {
    const credential = file('42', ' Codex ');
    expect(findPoolResetFile([credential], 's', 'codex', id('s', 'codex', '42'))).toBe(credential);
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

test('manual reset state table separates held credits, usability and tab requests', () => {
  const base = { available: 2, usable: 2, blocker: null, nextExpiryAtMs: 123, observedAtMs: 1 };
  expect(poolResetStatus(null, 'codex', false)).toBeNull();
  for (const provider of ['codex', 'claude'] as const) {
    for (const blocker of [
      null,
      'not_limited',
      'cooldown',
      'paused',
      'not_applicable',
      'ineligible:org',
    ] as const) {
      expect(
        poolResetStatus({ ...base, available: 0, usable: 0, blocker }, provider, false)
      ).toEqual({ valueKey: 'quota_pool.reset_none', statusKey: null, early: false });
      expect(poolResetStatus({ ...base, usable: 0, blocker }, provider, false)).toEqual({
        valueKey: 'quota_pool.reset_held',
        statusKey:
          provider === 'codex' && blocker === 'not_applicable'
            ? 'quota_pool.reset_early_status'
            : poolResetReasonKey(blocker),
        early: provider === 'codex' && blocker === 'not_applicable',
      });
    }
    expect(poolResetStatus(base, provider, false)).toEqual({
      valueKey: 'quota_pool.reset_held',
      statusKey: 'quota_pool.reset_usable',
      early: false,
    });
    expect(poolResetStatus({ ...base, usable: 1 }, provider, false)?.statusKey).toBe(
      'quota_pool.reset_usable_count'
    );
    expect(poolResetStatus(base, provider, true)).toEqual({
      valueKey: 'quota_pool.reset_requested',
      statusKey: 'quota_pool.reset_spent',
      early: false,
    });
  }
});

test('tab requests expire only when the server reading catches up', () => {
  const before = Date.now() - 1;
  expect(wasSpent('spent-fixture', before)).toBe(false);
  markSpent('spent-fixture');
  expect(wasSpent('spent-fixture', before)).toBe(true);
  expect(wasSpent('spent-fixture', Date.now())).toBe(false);
});

test('held expiries list each future expiry soonest first, never more than the resets held', () => {
  const base = { available: 3, usable: 3, blocker: null, nextExpiryAtMs: 200, observedAtMs: 1 };
  expect(heldExpiries({ ...base, expiries: [200, 300, 400] }, 100)).toEqual([200, 300, 400]);
  // An expiry that has passed since the reading is gone, and the list never outgrows the count.
  expect(heldExpiries({ ...base, expiries: [200, 300, 400] }, 250)).toEqual([300, 400]);
  expect(heldExpiries({ ...base, available: 1, expiries: [200, 300] }, 100)).toEqual([200]);
  // A reading from before per-reset detail still shows its one known expiry.
  expect(heldExpiries(base, 100)).toEqual([200]);
  expect(heldExpiries({ ...base, nextExpiryAtMs: null }, 100)).toEqual([]);
});
