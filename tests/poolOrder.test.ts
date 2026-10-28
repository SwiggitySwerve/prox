import { describe, expect, test } from 'bun:test';
import { movePool, orderPools, poolKey } from '../src/features/quotaPool/poolOrder';

const pool = (provider: 'claude' | 'codex', instanceId?: string) => ({ provider, instanceId });
const claude = pool('claude', 'claude-primary');
const codex = pool('codex', 'codex-primary');

describe('pool order', () => {
  test('keys pools by instance and provider', () => {
    expect(poolKey(claude)).toBe('claude-primary:claude');
    expect(poolKey(pool('codex'))).toBe('legacy:codex');
  });

  test('applies the saved order and appends pools it has not seen', () => {
    const extra = pool('claude', 'claude-second');
    expect(orderPools([claude, codex, extra], ['codex-primary:codex'])).toEqual([
      codex,
      claude,
      extra,
    ]);
    expect(orderPools([claude, codex], [])).toEqual([claude, codex]);
    expect(orderPools([claude], ['codex-primary:codex', 'claude-primary:claude'])).toEqual([
      claude,
    ]);
  });

  test('moves a pool one place and stops at the ends', () => {
    const shown = [claude, codex];
    expect(movePool(shown, 'codex-primary:codex', -1)).toEqual([
      'codex-primary:codex',
      'claude-primary:claude',
    ]);
    expect(movePool(shown, 'claude-primary:claude', -1)).toEqual([
      'claude-primary:claude',
      'codex-primary:codex',
    ]);
    expect(movePool(shown, 'codex-primary:codex', 1)).toEqual([
      'claude-primary:claude',
      'codex-primary:codex',
    ]);
  });
});
