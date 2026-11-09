import { describe, expect, test } from 'bun:test';
import {
  executeWrites,
  failedWrites,
  rollbackWrites,
  type ListIo,
} from '../src/features/authFiles/modelAccess/execute';
import type { ListWrite } from '../src/features/authFiles/modelAccess/writePlan';

/** In-memory hub lists with a call log and injectable write failures. */
function fakeIo(initial: { provider: string[] | null; accounts: Record<string, string[] | null> }) {
  const state = { provider: initial.provider, accounts: { ...initial.accounts } };
  const log: string[] = [];
  const failing = new Set<string>();
  const io: ListIo = {
    readProviderList: async () => {
      log.push('read provider');
      return state.provider;
    },
    readAccountList: async (name) => {
      log.push(`read ${name}`);
      return state.accounts[name] ?? null;
    },
    writeProviderList: async (rules) => {
      log.push('write provider');
      if (failing.has('provider')) throw new Error('provider write refused');
      state.provider = rules;
    },
    writeAccountList: async (name, rules) => {
      log.push(`write ${name}`);
      if (failing.has(name)) throw new Error(`${name} write refused`);
      state.accounts[name] = rules;
    },
  };
  return { io, state, log, failing };
}

const everywhere: ListWrite[] = [
  { target: { kind: 'provider' }, before: ['a'], after: ['a', 'x'] },
  { target: { kind: 'account', name: 'b.json' }, before: ['b'], after: ['b', 'x'] },
  { target: { kind: 'account', name: 'c.json' }, before: ['c'], after: ['c', 'x'] },
];
const start = () => fakeIo({ provider: ['a'], accounts: { 'b.json': ['b'], 'c.json': ['c'] } });

describe('executeWrites', () => {
  test('re-reads every target, then writes account lists before the provider list', async () => {
    const hub = start();
    const result = await executeWrites(everywhere, hub.io);
    expect(result.status).toBe('saved');
    expect(hub.log).toEqual([
      'read b.json',
      'read c.json',
      'read provider',
      'write b.json',
      'write c.json',
      'write provider',
    ]);
    expect(hub.state).toEqual({
      provider: ['a', 'x'],
      accounts: { 'b.json': ['b', 'x'], 'c.json': ['c', 'x'] },
    });
  });

  test('a target changed since the preview aborts with no write at all', async () => {
    const hub = start();
    hub.state.accounts['c.json'] = ['c', 'someone-else'];
    const result = await executeWrites(everywhere, hub.io);
    expect(result).toEqual({
      status: 'stale',
      stale: [
        {
          target: { kind: 'account', name: 'c.json' },
          expected: ['c'],
          actual: ['c', 'someone-else'],
        },
      ],
    });
    expect(hub.log.filter((entry) => entry.startsWith('write'))).toEqual([]);
  });

  test('case and order differences are not stale', async () => {
    const hub = fakeIo({ provider: ['B', 'A'], accounts: {} });
    const result = await executeWrites(
      [{ target: { kind: 'provider' }, before: ['a', 'b'], after: null }],
      hub.io
    );
    expect(result.status).toBe('saved');
    expect(hub.state.provider).toBeNull();
  });

  test('partial failure reports each write and keeps going', async () => {
    const hub = start();
    hub.failing.add('c.json');
    const result = await executeWrites(everywhere, hub.io);
    expect(result.status).toBe('partial-failure');
    if (result.status === 'stale') throw new Error('unexpected');
    expect(result.outcomes.map((outcome) => [outcome.write.target, outcome.status])).toEqual([
      [{ kind: 'account', name: 'b.json' }, 'ok'],
      [{ kind: 'account', name: 'c.json' }, 'failed'],
      [{ kind: 'provider' }, 'ok'],
    ]);
    expect(result.outcomes[1]).toMatchObject({ message: 'c.json write refused' });
  });

  test('every write failing is failed, not partial', async () => {
    const hub = fakeIo({ provider: ['a'], accounts: {} });
    hub.failing.add('provider');
    const result = await executeWrites([everywhere[0]], hub.io);
    expect(result.status).toBe('failed');
  });

  test('a read that throws propagates (the session turns it into failed)', async () => {
    const hub = start();
    hub.io.readProviderList = async () => {
      throw new Error('read refused');
    };
    await expect(executeWrites(everywhere, hub.io)).rejects.toThrow('read refused');
  });
});

describe('retry and rollback', () => {
  test('retry re-runs only the failed writes, after a fresh stale check', async () => {
    const hub = start();
    hub.failing.add('c.json');
    const first = await executeWrites(everywhere, hub.io);
    if (first.status === 'stale') throw new Error('unexpected');
    hub.failing.clear();
    hub.log.length = 0;
    const retry = await executeWrites(failedWrites(first.outcomes), hub.io);
    expect(retry.status).toBe('saved');
    expect(hub.log).toEqual(['read c.json', 'write c.json']);
    expect(hub.state.accounts['c.json']).toEqual(['c', 'x']);
  });

  test('rollback restores every successful write, guarded by its after value', async () => {
    const hub = start();
    hub.failing.add('c.json');
    const first = await executeWrites(everywhere, hub.io);
    if (first.status === 'stale') throw new Error('unexpected');
    const undo = await executeWrites(rollbackWrites(first.outcomes), hub.io);
    expect(undo.status).toBe('saved');
    expect(hub.state).toEqual({ provider: ['a'], accounts: { 'b.json': ['b'], 'c.json': ['c'] } });
  });

  test('rollback refuses when someone changed a list after our write', async () => {
    const hub = start();
    hub.failing.add('c.json');
    const first = await executeWrites(everywhere, hub.io);
    if (first.status === 'stale') throw new Error('unexpected');
    hub.state.provider = ['a', 'x', 'later'];
    const undo = await executeWrites(rollbackWrites(first.outcomes), hub.io);
    expect(undo.status).toBe('stale');
    expect(hub.state.accounts['b.json']).toEqual(['b', 'x']);
  });
});
