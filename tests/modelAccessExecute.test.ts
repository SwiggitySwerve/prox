import { describe, expect, test } from 'bun:test';
import {
  executeWrites,
  failedWrites,
  refreshScope,
  rollbackWrites,
  type ListIo,
} from '../src/features/authFiles/modelAccess/execute';
import type { ListWrite } from '../src/features/authFiles/modelAccess/writePlan';
import { inventory, runtimeAccount } from './fixtures/modelAccess';

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
      // each target is read once more right before its write
      'read b.json',
      'write b.json',
      'read c.json',
      'write c.json',
      'read provider',
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
      outcomes: [
        { write: everywhere[1], status: 'skipped' },
        { write: everywhere[2], status: 'skipped' },
        { write: everywhere[0], status: 'skipped' },
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

describe('lists the plan depends on but does not write', () => {
  test('a guarded list that changed since the preview is stale, with nothing written', async () => {
    // "Exclude x everywhere": team-a inherits, so the provider write covers it. Another operator
    // gives it its own list between preview and Apply: it would keep serving x.
    const hub = fakeIo({ provider: ['a'], accounts: { 'b.json': ['b'], 'team-a.json': null } });
    hub.state.accounts['team-a.json'] = ['other'];
    const result = await executeWrites(everywhere.slice(0, 2), hub.io, [
      { target: { kind: 'account', name: 'team-a.json' }, expected: null },
    ]);
    expect(result).toMatchObject({
      status: 'stale',
      stale: [
        {
          target: { kind: 'account', name: 'team-a.json' },
          expected: null,
          actual: ['other'],
          guard: true,
        },
      ],
    });
    expect(hub.log.filter((entry) => entry.startsWith('write'))).toEqual([]);
  });

  test('an unchanged guard is only read, never written', async () => {
    const hub = fakeIo({ provider: ['a'], accounts: { 'b.json': ['b'], 'team-a.json': null } });
    const result = await executeWrites(everywhere.slice(0, 2), hub.io, [
      { target: { kind: 'account', name: 'team-a.json' }, expected: null },
    ]);
    expect(result.status).toBe('saved');
    expect(hub.log).toContain('read team-a.json');
    expect(hub.log).not.toContain('write team-a.json');
  });
});

describe('each target is re-read right before it is written', () => {
  test('a list changed after the check stops the run there and says what was written', async () => {
    const hub = start();
    const write = hub.io.writeAccountList;
    hub.io.writeAccountList = async (name, rules) => {
      await write(name, rules);
      if (name === 'b.json') hub.state.accounts['c.json'] = ['c', 'someone-else'];
    };
    const result = await executeWrites(everywhere, hub.io);
    expect(result.status).toBe('stale');
    if (result.status !== 'stale') throw new Error('unexpected');
    expect(result.stale).toEqual([
      {
        target: { kind: 'account', name: 'c.json' },
        expected: ['c'],
        actual: ['c', 'someone-else'],
      },
    ]);
    expect(result.outcomes.map((outcome) => [outcome.write.target, outcome.status])).toEqual([
      [{ kind: 'account', name: 'b.json' }, 'ok'],
      [{ kind: 'account', name: 'c.json' }, 'skipped'],
      [{ kind: 'provider' }, 'skipped'],
    ]);
    // c.json keeps the other operator's list; the provider list is untouched.
    expect(hub.state).toEqual({
      provider: ['a'],
      accounts: { 'b.json': ['b', 'x'], 'c.json': ['c', 'someone-else'] },
    });
  });

  test('a re-read that throws mid-run fails that write only; earlier writes are reported', async () => {
    const hub = start();
    const read = hub.io.readAccountList;
    let reads = 0;
    hub.io.readAccountList = async (name) => {
      if (name === 'c.json' && ++reads === 2) throw new Error('read refused');
      return read(name);
    };
    const result = await executeWrites(everywhere, hub.io);
    expect(result.status).toBe('partial-failure');
    if (result.status === 'stale') throw new Error('unexpected');
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'failed', 'ok']);
    expect(result.outcomes[1]).toMatchObject({ message: 'read refused' });
    expect(hub.state.accounts['c.json']).toEqual(['c']);
  });
});

describe('what is re-read after a write', () => {
  const inv = inventory();
  test('an own-list write re-reads that account only', () => {
    expect(refreshScope([{ kind: 'account', name: 'team-b.json' }], inv.accounts)).toEqual({
      lists: ['team-b.json'],
      models: ['team-b.json'],
    });
  });

  test('a provider write re-reads the models of every enabled inheriting account', () => {
    expect(
      refreshScope(
        [{ kind: 'account', name: 'team-b.json' }, { kind: 'provider' }],
        [...inv.accounts, runtimeAccount('runtime:1', ['claude-haiku-4-5'])]
      )
    ).toEqual({
      lists: ['team-b.json'],
      // pro-c is disabled (serves nothing); a runtime credential follows the provider list too.
      models: ['team-b.json', 'team-a.json', 'max-d.json', 'runtime:1'],
    });
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
    expect(hub.log).toEqual(['read c.json', 'read c.json', 'write c.json']);
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
