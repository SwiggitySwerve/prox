import { describe, expect, test } from 'bun:test';
import { providerAccountCount } from '../src/features/quotaPool/presentation';

const pool = (provider: 'claude' | 'codex', instanceId: string, accountCount: number) => ({
  provider,
  instanceId,
  accountCount,
});

describe('provider chip count', () => {
  test('counts the accounts of one provider across its sources', () => {
    const pools = [pool('codex', 'codex-primary', 2), pool('claude', 'claude-primary', 2)];
    expect(providerAccountCount(pools, 'claude')).toBe(2);
    expect(providerAccountCount(pools, 'codex')).toBe(2);
  });

  // A hub that cannot be read keeps an empty pool for every provider it could serve. It must not
  // hide the accounts another hub still has for that provider.
  test('an empty pool kept for a failed hub does not zero the provider', () => {
    const pools = [
      pool('claude', 'codex-primary', 0),
      pool('codex', 'codex-primary', 2),
      pool('claude', 'claude-primary', 2),
    ];
    expect(providerAccountCount(pools, 'claude')).toBe(2);
  });

  test('sums sources that each hold accounts, and is 0 with no pool', () => {
    const pools = [pool('claude', 'a', 2), pool('claude', 'b', 3)];
    expect(providerAccountCount(pools, 'claude')).toBe(5);
    expect(providerAccountCount([], 'codex')).toBe(0);
  });
});
