import { afterEach, describe, expect, test } from 'bun:test';
import { RETIRED_ACCOUNT_NAME } from '../server/quota/types';
import { cleanupHarnesses, deferred, file, harness, NOW, until } from './helpers/inventoryHarness';

afterEach(cleanupHarnesses);

describe('inventory-only sync', () => {
  test('reads only the credential lists and never calls a usage endpoint', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    h.lists['claude-primary'] = [file('claude', 'c')];
    const change = await h.collector.syncInventory();
    expect(change.added).toHaveLength(3);
    expect(h.calls.map((call) => `${call.instanceId} ${call.path}`).sort()).toEqual([
      'claude-primary /credentials',
      'codex-primary /credentials',
    ]);
    expect(h.store.listAccounts().map((account) => account.retired)).toEqual([false, false, false]);
    expect(h.collector.inventorySyncedAtMs).toBe(NOW);
  });

  test('is not held back by the four minute manual refresh limit', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    await h.collector.refresh();
    const afterFirst = h.calls.length;
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    await h.collector.refresh();
    expect(h.calls.length).toBe(afterFirst); // the manual refresh was skipped
    expect(h.row(h.idOf('b'))).toBeUndefined();
    const change = await h.collector.syncInventory();
    expect(change.added).toEqual([h.idOf('b')]);
    expect(h.row(h.idOf('b'))?.retired).toBe(false);
  });

  test('single flight: concurrent calls share one extra read, merge their names, and wait out a one second floor', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b'), file('codex', 'c')];
    await h.collector.syncInventory();
    expect(h.credentialReads['codex-primary']).toBe(1);
    const gate = deferred();
    h.hooks.credentials = (instanceId, n) =>
      instanceId === 'codex-primary' && n === 2 ? gate.promise : undefined;
    const first = h.collector.syncInventory();
    await until(() => h.credentialReads['codex-primary'] === 2);
    // The user deletes a and b while a read that began before the delete is still in flight.
    h.lists['codex-primary'] = [file('codex', 'c')];
    const second = h.collector.syncInventory({ deletedNames: ['a.json'] });
    const third = h.collector.syncInventory({ deletedNames: ['b.json'] });
    expect(third).toBe(second);
    gate.release();
    await first;
    const change = await second;
    expect(h.credentialReads['codex-primary']).toBe(3); // one coalesced read, not two
    expect(change.purged.sort()).toEqual([h.idOf('a'), h.idOf('b')].sort());
    expect(h.row(h.idOf('a'))).toBeUndefined();
    expect(h.row(h.idOf('b'))).toBeUndefined();
    expect(h.row(h.idOf('c'))?.retired).toBe(false);
    // Each run started less than a second after the previous one, so it waited out the floor.
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  test('a read that starts after the floor does not wait', async () => {
    const h = harness();
    await h.collector.syncInventory();
    h.advance(1000);
    await h.collector.syncInventory();
    expect(h.sleeps).toEqual([]);
  });
});

describe('failed or malformed inventories', () => {
  const malformed: [string, number | unknown][] = [
    ['an HTTP 503', 503],
    ['a body that is not an inventory', { files: 'nope' }],
    ['a truncated page', { files: [], has_more: true }],
    ['a total that disagrees with the files', { files: [], total: 3 }],
    ['an entry that is not a record', { files: [7] }],
    ['an entry without an auth_index', { files: [{ ...file('codex', 'z'), auth_index: '' }] }],
  ];
  for (const [label, response] of malformed) {
    test(`retire nothing: ${label}`, async () => {
      const h = harness();
      h.lists['codex-primary'] = [file('codex', 'a')];
      await h.collector.syncInventory();
      h.override['codex-primary'] = response;
      const change = await h.collector.syncInventory();
      expect(change).toEqual({ added: [], removed: [], purged: [] });
      expect(h.row(h.idOf('a'))).toMatchObject({ retired: false, email: 'shared@example.test' });
      expect(
        h.collector.inventorySources.find(
          (s) => s.instanceId === 'codex-primary' && s.provider === 'codex'
        )?.state
      ).toBe('unavailable');
      expect(h.collector.issues.some((issue) => issue.code === 'inventory-unavailable')).toBe(true);
    });
  }

  test('one failing source does not stop another from retiring its own accounts', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    h.lists['claude-primary'] = [file('claude', 'b')];
    await h.collector.syncInventory();
    h.override['codex-primary'] = 503;
    h.lists['claude-primary'] = [];
    const change = await h.collector.syncInventory({ deletedNames: ['a.json', 'b.json'] });
    expect(change.purged).toEqual([h.idOf('b', 'claude-primary')]);
    expect(h.row(h.idOf('a'))?.retired).toBe(false); // named, but its source could not confirm
  });

  test('recovery: the next good read clears the unavailable state and the issue', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    h.override['codex-primary'] = 503;
    await h.collector.syncInventory();
    delete h.override['codex-primary'];
    await h.collector.syncInventory();
    expect(h.collector.inventorySources.every((source) => source.state === 'ok')).toBe(true);
    expect(h.collector.issues).toEqual([]);
  });

  test('names that do not end in .json are ignored without invalidating the inventory', async () => {
    const h = harness();
    h.lists['codex-primary'] = [
      file('codex', 'a'),
      { name: 'a.json.lock' },
      { ...file('codex', 'lk'), name: 'lk.lock' },
      { ...file('codex', 'cfg'), name: 'config.yaml' },
    ];
    await h.collector.syncInventory();
    expect(h.store.listAccounts().map((account) => account.id)).toEqual([h.idOf('a')]);
    expect(h.collector.inventorySources.every((source) => source.state === 'ok')).toBe(true);
  });
});

describe('retire, purge and re-add through the collector', () => {
  test('absence alone scrubs; naming a deleted credential purges; neither polls the provider', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b'), file('codex', 'c')];
    await h.collector.syncInventory();
    h.lists['codex-primary'] = [file('codex', 'c')];
    await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(h.row(h.idOf('a'))).toBeUndefined();
    expect(h.row(h.idOf('b'))).toMatchObject({
      retired: true,
      email: null,
      name: RETIRED_ACCOUNT_NAME,
      retiredAtMs: NOW,
    });
    expect(h.usageCalls()).toEqual([]);
  });

  test('a read that already retired the account does not stop a later delete sync from purging it', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    await h.collector.syncInventory();
    h.lists['codex-primary'] = [file('codex', 'b')];
    const reconcile = await h.collector.syncInventory(); // e.g. another tab's poll
    expect(reconcile.removed).toEqual([h.idOf('a')]);
    expect(h.row(h.idOf('a'))).toMatchObject({ retired: true, name: RETIRED_ACCOUNT_NAME });
    const change = await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(change.purged).toEqual([h.idOf('a')]);
    expect(h.row(h.idOf('a'))).toBeUndefined();
    expect(h.row(h.idOf('b'))?.retired).toBe(false);
  });

  test('a remembered name purges only when its own source was read fresh in that sync', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    await h.collector.syncInventory();
    h.lists['codex-primary'] = [file('codex', 'b')];
    await h.collector.syncInventory();
    h.override['codex-primary'] = 503;
    const blind = await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(blind.purged).toEqual([]);
    expect(h.row(h.idOf('a'))?.retired).toBe(true);
    delete h.override['codex-primary'];
    const change = await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(change.purged).toEqual([h.idOf('a')]);
  });

  test('that memory of retired names is short: later, only the 24 h grace purges', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    await h.collector.syncInventory();
    h.lists['codex-primary'] = [];
    await h.collector.syncInventory();
    h.advance(11 * 60_000);
    const change = await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(change.purged).toEqual([]);
    expect(h.row(h.idOf('a'))?.retired).toBe(true);
  });

  test('an account that comes back is restored with its history', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    await h.collector.refresh();
    const id = h.idOf('a');
    const samples = h.store.listSamples(0, NOW + 1).length;
    expect(samples).toBeGreaterThan(0);
    h.lists['codex-primary'] = [];
    await h.collector.syncInventory();
    expect(h.row(id)?.retired).toBe(true);
    h.advance(2000);
    h.lists['codex-primary'] = [file('codex', 'a')];
    const change = await h.collector.syncInventory();
    expect(change.added).toEqual([id]);
    expect(h.row(id)).toMatchObject({
      retired: false,
      email: 'shared@example.test',
      name: 'a.json',
    });
    expect(h.store.listSamples(0, NOW + 1)).toHaveLength(samples);
  });

  test('forget clears every per-account map and the next collection skips removed accounts', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    await h.collector.refresh();
    const [a, b] = [h.idOf('a'), h.idOf('b')];
    expect(h.collector.windows.has(a) && h.collector.windows.has(b)).toBe(true);
    expect(h.collector.resets.has(a)).toBe(false); // codex fixture has no reset credits
    h.lists['codex-primary'] = [file('codex', 'b')];
    await h.collector.syncInventory();
    expect(h.collector.windows.has(a)).toBe(false);
    expect(h.collector.windows.has(b)).toBe(true);
    const before = h.usageCalls().length;
    h.advance(5 * 60_000);
    await h.collector.refresh();
    const polled = h
      .usageCalls()
      .slice(before)
      .map((call) => call.body?.authIndex);
    expect(polled).toEqual(['b']);
  });

  test('forget() directly clears windows, resets, billing and attempt gates', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    await h.collector.refresh();
    const id = h.idOf('a');
    expect(h.collector.windows.has(id)).toBe(true);
    h.collector.forget([id]);
    expect(h.collector.windows.has(id)).toBe(false);
    expect(h.collector.resets.has(id)).toBe(false);
    expect(h.collector.billing.has(id)).toBe(false);
  });
});

describe('races between a sync and a collection', () => {
  test('a stale inventory read cannot re-add an account a newer sync removed', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    await h.collector.syncInventory();
    h.advance(2000);
    const stale = deferred();
    let held = 0;
    h.hooks.credentials = (instanceId) =>
      instanceId === 'codex-primary' && ++held === 1 ? stale.promise : undefined;
    const collecting = h.collector.refresh(); // reads the list that still contains a
    await until(() => held === 1);
    h.lists['codex-primary'] = [file('codex', 'b')];
    await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(h.row(h.idOf('a'))).toBeUndefined();
    stale.release();
    await collecting; // the stale read arrives now and must be dropped
    expect(h.row(h.idOf('a'))).toBeUndefined();
    expect(h.usageCalls().map((call) => call.body?.authIndex)).not.toContain('a');
  });

  test('a stale read cannot un-retire an account either', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    await h.collector.syncInventory();
    h.advance(2000);
    const stale = deferred();
    let held = 0;
    h.hooks.credentials = (instanceId) =>
      instanceId === 'codex-primary' && ++held === 1 ? stale.promise : undefined;
    const collecting = h.collector.refresh();
    await until(() => held === 1);
    h.lists['codex-primary'] = [];
    await h.collector.syncInventory();
    stale.release();
    await collecting;
    expect(h.row(h.idOf('a'))).toMatchObject({ retired: true, email: null });
  });

  test('removing an account aborts its in-flight poll and the collection still completes', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    const never = deferred();
    h.hooks.usage = (authIndex, signal) =>
      authIndex === 'a'
        ? new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
            void never.promise;
          })
        : undefined;
    const collecting = h.collector.refresh();
    await until(() => h.signals.some((entry) => entry.authIndex === 'a'));
    h.lists['codex-primary'] = [file('codex', 'b')];
    await h.collector.syncInventory({ deletedNames: ['a.json'] });
    expect(h.signals.find((entry) => entry.authIndex === 'a')!.signal.aborted).toBe(true);
    await collecting;
    expect(h.store.listSamples(0, NOW + 1).map((sample) => sample.accountId)).toEqual(
      expect.arrayContaining([h.idOf('b')])
    );
    expect(h.store.listSamples(0, NOW + 1).some((sample) => sample.accountId === h.idOf('a'))).toBe(
      false
    );
    expect(h.collector.windows.has(h.idOf('a'))).toBe(false);
  });

  test('a poll that returns after its rows were purged is dropped instead of failing the collection', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    await h.collector.syncInventory();
    h.advance(2000);
    const slow = deferred();
    h.hooks.usage = (authIndex) => (authIndex === 'a' ? slow.promise : undefined);
    const collecting = h.collector.refresh();
    await until(() => h.usageCalls().some((call) => call.body?.authIndex === 'a'));
    // Purge underneath the collector, so nothing aborts the poll: only the liveness check can save it.
    h.store.recordInventory(
      'codex',
      [h.store.listAccounts().find((account) => account.id === h.idOf('b'))!],
      NOW + 1,
      'codex-primary',
      new Set(['a.json'])
    );
    expect(h.row(h.idOf('a'))).toBeUndefined();
    slow.release();
    await collecting; // a foreign-key failure here would reject with "Quota refresh failed"
    expect(h.store.listSamples(0, NOW + 1).some((sample) => sample.accountId === h.idOf('a'))).toBe(
      false
    );
    expect(h.collector.windows.has(h.idOf('a'))).toBe(false);
    expect(h.collector.issues.some((issue) => issue.code === 'quota-unavailable')).toBe(false);
  });
});

describe('first poll for new accounts', () => {
  test('pollAdded polls each new account once, after and apart from the sync', async () => {
    const h = harness();
    h.lists['codex-primary'] = [file('codex', 'a')];
    await h.collector.syncInventory();
    h.advance(2000);
    h.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'n')];
    const change = await h.collector.syncInventory();
    expect(change.added).toEqual([h.idOf('n')]);
    expect(h.usageCalls()).toEqual([]);
    await h.collector.pollAdded(change.added);
    expect(h.usageCalls().map((call) => call.body?.authIndex)).toEqual(['n']);
    expect(
      h.store.listSamples(0, NOW + 5).every((sample) => sample.accountId === h.idOf('n'))
    ).toBe(true);
    await h.collector.pollAdded(change.added); // inside the 20 s per-account gate
    expect(h.usageCalls()).toHaveLength(1);
  });
});
