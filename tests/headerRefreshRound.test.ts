import { describe, expect, test } from 'bun:test';
import {
  runHeaderRefresh,
  type HeaderRefreshDeps,
} from '../src/components/layout/headerRefreshRound';
import type { HeaderRefreshRound } from '../src/hooks/useHeaderRefresh';

function fakes(overrides: Partial<HeaderRefreshDeps> = {}) {
  const calls: string[] = [];
  let seenRound: HeaderRefreshRound | null = null;
  const deps: HeaderRefreshDeps = {
    armAuthProbes: () => void calls.push('arm'),
    deniedHubs: () => [],
    selectedHub: () => 'alpha',
    clearConfigCache: () => void calls.push('clear-config'),
    refreshConfig: async () => void calls.push('config'),
    refreshPlugins: async () => {
      calls.push('plugins');
      return [];
    },
    refreshInventory: async () => {
      calls.push('inventory');
      return { alpha: null, beta: null };
    },
    refreshModelAccess: async () => {
      calls.push('models');
      return [];
    },
    refreshPage: async (round) => {
      calls.push('page');
      seenRound = round;
      await round.inventory;
    },
    ...overrides,
  };
  return { deps, calls, round: () => seenRound };
}

describe('header refresh', () => {
  test('one click reloads every store and the open page, after arming the hubs', async () => {
    const { deps, calls } = fakes();
    const summary = await runHeaderRefresh(deps);
    expect(calls[0]).toBe('arm');
    expect(new Set(calls)).toEqual(
      new Set(['arm', 'clear-config', 'config', 'plugins', 'inventory', 'models', 'page'])
    );
    // each store is read once per click
    expect(calls.filter((call) => call === 'inventory')).toHaveLength(1);
    expect(summary).toEqual({ failed: [], deniedHubs: [] });
  });

  test('the page gets the round’s one credential read instead of listing again', async () => {
    let reads = 0;
    const { deps, round } = fakes({
      refreshInventory: async () => {
        reads += 1;
        return { alpha: null };
      },
    });
    await runHeaderRefresh(deps);
    expect(await round()!.inventory).toEqual({ alpha: null });
    expect(reads).toBe(1);
  });

  test('stays busy until the slowest source settles', async () => {
    let finishPage!: () => void;
    const { deps } = fakes({
      refreshPage: () => new Promise<void>((resolve) => (finishPage = resolve)),
    });
    let done = false;
    const run = runHeaderRefresh(deps).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    finishPage();
    await run;
    expect(done).toBe(true);
  });

  test('one summary names every source that failed', async () => {
    const { deps } = fakes({
      refreshConfig: async () => {
        throw new Error('config down');
      },
      refreshInventory: async () => ({ alpha: null, beta: new Error('beta down') }),
      refreshModelAccess: async () => ['alpha'],
      refreshPlugins: async () => ['beta'],
      refreshPage: async (round) => {
        round.quotaFailed('alpha', 2);
        round.quotaFailed('alpha', 1);
        throw new Error('page down');
      },
    });
    expect(await runHeaderRefresh(deps)).toEqual({
      failed: [
        { source: 'config' },
        { source: 'plugins', hub: 'beta' },
        { source: 'credentials', hub: 'beta' },
        { source: 'models', hub: 'alpha' },
        { source: 'quota', hub: 'alpha', count: 3 },
        { source: 'page' },
      ],
      deniedHubs: [],
    });
  });

  test('a hub that refused the key is reported once, and the main hub is not asked again', async () => {
    const denied = new Set<string>();
    const { deps, calls } = fakes({
      deniedHubs: () => [...denied],
      refreshInventory: async () => {
        calls.push('inventory');
        denied.add('alpha');
        return { alpha: new Error('401'), beta: null };
      },
      refreshModelAccess: async () => ['alpha'],
    });
    const summary = await runHeaderRefresh(deps);
    // config goes through the main (alpha) connection: no second wrong-key request
    expect(calls).not.toContain('config');
    expect(calls).not.toContain('clear-config');
    expect(summary).toEqual({ failed: [], deniedHubs: ['alpha'] });
  });
});
