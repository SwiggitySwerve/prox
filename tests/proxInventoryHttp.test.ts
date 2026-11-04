import { afterEach, describe, expect, test } from 'bun:test';
import { createHandler } from '../server/app';
import { cleanupHarnesses, file, harness, NOW, until } from './helpers/inventoryHarness';

afterEach(cleanupHarnesses);

const auth = { Authorization: 'Bearer synthetic-management-key' };

/** The real handler, store and collector over a fake CLI-Proxy; only the clock is synthetic. */
function app() {
  const h = harness();
  const handler = createHandler({
    store: h.store,
    collector: h.collector,
    keyFile: h.keyFile,
    now: h.now,
  });
  const call = (path: string, init: RequestInit & { auth?: boolean } = {}) =>
    handler(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { ...(init.auth === false ? {} : auth), ...init.headers },
      })
    );
  const sync = (body: unknown) =>
    call('/v1/inventory/sync', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { ...h, call, sync };
}

describe('GET /v1/inventory', () => {
  test('requires the bearer key', async () => {
    const a = app();
    expect((await a.call('/v1/inventory', { auth: false })).status).toBe(401);
    expect(
      (await a.call('/v1/inventory/sync', { method: 'POST', auth: false, body: '{}' })).status
    ).toBe(401);
  });

  test('answers the documented shape with a quoted version as its ETag', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b', true)];
    a.lists['claude-primary'] = [file('claude', 'c')];
    const response = await a.call('/v1/inventory');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      syncedAtMs: number;
      sources: {
        instanceId: string;
        provider: string;
        state: string;
        accounts: { accountId: string; sourceAccountId: string; disabled: boolean }[];
      }[];
    };
    expect(response.headers.get('ETag')).toBe(`"${body.version}"`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.syncedAtMs).toBe(NOW);
    expect(body.sources.map((s) => [s.instanceId, s.provider, s.state, s.accounts.length])).toEqual(
      [
        ['codex-primary', 'claude', 'ok', 0],
        ['codex-primary', 'codex', 'ok', 2],
        ['claude-primary', 'claude', 'ok', 1],
        ['claude-primary', 'codex', 'ok', 0],
      ]
    );
    const codex = body.sources.find(
      (s) => s.instanceId === 'codex-primary' && s.provider === 'codex'
    )!;
    expect(codex.accounts.map((account) => account.disabled).sort()).toEqual([false, true]);
    expect(Object.keys(codex.accounts[0]).sort()).toEqual([
      'accountId',
      'disabled',
      'sourceAccountId',
    ]);
  });

  test('If-None-Match answers 304 with no body; any other tag gets the full inventory', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    const first = await a.call('/v1/inventory');
    const etag = first.headers.get('ETag')!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const again = await a.call('/v1/inventory', { headers: { 'If-None-Match': header } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe('');
      expect(again.headers.get('ETag')).toBe(etag);
    }
    const stale = await a.call('/v1/inventory', { headers: { 'If-None-Match': '"stale"' } });
    expect(stale.status).toBe(200);
  });

  test('a membership change moves the ETag', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    const before = (await a.call('/v1/inventory')).headers.get('ETag')!;
    a.advance(6000);
    a.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    const after = await a.call('/v1/inventory', { headers: { 'If-None-Match': before } });
    expect(after.status).toBe(200);
    expect(after.headers.get('ETag')).not.toBe(before);
  });

  test('reconciles lazily: only when the last sync is more than 5 s old', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    await a.call('/v1/inventory');
    expect(a.credentialReads['codex-primary']).toBe(1);
    a.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    a.advance(5000);
    const fresh = (await (await a.call('/v1/inventory')).json()) as {
      sources: { accounts: unknown[] }[];
    };
    expect(a.credentialReads['codex-primary']).toBe(1); // exactly 5 s: still fresh
    expect(fresh.sources.flatMap((s) => s.accounts)).toHaveLength(1);
    a.advance(1);
    const reconciled = (await (await a.call('/v1/inventory')).json()) as {
      sources: { accounts: unknown[] }[];
    };
    // The reconcile read, plus the targeted first poll of the account it found.
    expect(a.credentialReads['codex-primary']).toBeGreaterThanOrEqual(2);
    expect(reconciled.sources.flatMap((s) => s.accounts)).toHaveLength(2);
  });

  test('carries no name or email, anywhere in the body, even after a retire', async () => {
    const a = app();
    a.lists['codex-primary'] = [
      { ...file('codex', 'secret-name'), email: 'private.person@example.test' },
    ];
    expect(await (await a.call('/v1/inventory')).text()).not.toMatch(
      /secret|private|example\.test/
    );
    a.advance(6000);
    a.lists['codex-primary'] = [];
    const text = await (await a.call('/v1/inventory')).text();
    expect(text).not.toMatch(/secret|private|example\.test/);
  });

  test('an inventory that cannot be read retires nothing and reports the source unavailable', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    await a.call('/v1/inventory');
    a.advance(6000);
    a.override['codex-primary'] = 503;
    const response = await a.call('/v1/inventory');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sources: { instanceId: string; provider: string; state: string; accounts: unknown[] }[];
    };
    const codex = body.sources.find(
      (s) => s.instanceId === 'codex-primary' && s.provider === 'codex'
    )!;
    expect(codex.state).toBe('unavailable');
    expect(codex.accounts).toHaveLength(1);
    expect(a.store.listAccounts().every((account) => !account.retired)).toBe(true);
  });
});

describe('POST /v1/inventory/sync', () => {
  test('is not held back by the 4 minute refresh limit and returns the version with counts', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    expect((await a.call('/v1/refresh', { method: 'POST' })).status).toBe(202);
    await until(() => !a.collector.refreshing);
    const usageBefore = a.usageCalls().length;
    a.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b')];
    // A second manual refresh is swallowed by the gate: it reads nothing.
    const reads = a.credentialReads['codex-primary'];
    await a.call('/v1/refresh', { method: 'POST' });
    expect(a.credentialReads['codex-primary']).toBe(reads);
    const response = await a.sync({ reason: 'add' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string; added: number; removed: number };
    expect(body).toEqual({
      version: expect.stringMatching(/^[0-9a-f]{16}$/),
      added: 1,
      removed: 0,
    });
    const inventory = (await (await a.call('/v1/inventory')).json()) as { version: string };
    expect(body.version).toBe(inventory.version);
    expect(a.usageCalls().length).toBeGreaterThanOrEqual(usageBefore);
  });

  test('polls a newly added account once, after answering, and polls nothing else', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    await a.sync({ reason: 'add' });
    await until(() => a.usageCalls().length === 1);
    a.advance(2000);
    a.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'n')];
    await a.sync({ reason: 'add' });
    await until(() => a.usageCalls().length === 2);
    expect(a.usageCalls().map((call) => call.body?.authIndex)).toEqual(['a', 'n']);
  });

  test('a delete sync purges named credentials immediately; other reasons never purge', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a'), file('codex', 'b'), file('codex', 'c')];
    await a.sync({ reason: 'change' });
    a.advance(2000);
    a.lists['codex-primary'] = [file('codex', 'c')];
    const notDeleting = await a.sync({ reason: 'change', deletedNames: ['a.json'] });
    expect(await notDeleting.json()).toMatchObject({ added: 0, removed: 2 });
    expect(a.row(a.idOf('a'))).toMatchObject({ retired: true, email: null });
    a.advance(2000);
    const deleting = await a.sync({ reason: 'delete', deletedNames: ['a.json'] });
    expect(await deleting.json()).toMatchObject({ removed: 1 });
    expect(a.row(a.idOf('a'))).toBeUndefined();
    expect(a.row(a.idOf('b'))?.retired).toBe(true); // absent but not named: scrubbed, kept 24 h
  });

  test('validates a bounded body', async () => {
    const a = app();
    const names = (count: number) => Array.from({ length: count }, (_, index) => `${index}.json`);
    const invalid: unknown[] = [
      '',
      '{',
      'null',
      '[]',
      {},
      { reason: 'purge' },
      { reason: 7 },
      { reason: 'delete', deletedNames: 'a.json' },
      { reason: 'delete', deletedNames: names(201) },
      { reason: 'delete', deletedNames: [7] },
      { reason: 'delete', deletedNames: [''] },
      { reason: 'delete', deletedNames: ['x'.repeat(1025)] },
      { reason: 'delete', deletedNames: ['x'.repeat(1000)], padding: 'y'.repeat(256 * 1024) },
    ];
    for (const body of invalid) expect((await a.sync(body as string)).status).toBe(400);
    expect((await a.call('/v1/inventory/sync', { method: 'POST' })).status).toBe(400);
    expect(a.calls).toEqual([]); // nothing was read for a bad request
    for (const good of [
      { reason: 'add' },
      { reason: 'delete', deletedNames: names(200) },
      { reason: 'change', deletedNames: [] },
    ]) {
      a.advance(2000);
      expect((await a.sync(good)).status).toBe(200);
    }
  });

  test('answers 503, retiring nothing, when no source can be read', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    await a.sync({ reason: 'add' });
    a.advance(2000);
    a.override['codex-primary'] = 503;
    a.override['claude-primary'] = { files: 'malformed' };
    const response = await a.sync({ reason: 'delete', deletedNames: ['a.json'] });
    expect(response.status).toBe(503);
    expect(a.row(a.idOf('a'))).toMatchObject({ retired: false, email: 'shared@example.test' });
  });

  test('still answers 200 when only one source fails', async () => {
    const a = app();
    a.lists['claude-primary'] = [file('claude', 'c')];
    a.override['codex-primary'] = 503;
    const response = await a.sync({ reason: 'add' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: 1 });
  });
});

describe('GET /v1/pools carries the inventory version', () => {
  test('equals the version of GET /v1/inventory and moves with membership', async () => {
    const a = app();
    a.lists['codex-primary'] = [file('codex', 'a')];
    const inventory = (await (await a.call('/v1/inventory')).json()) as { version: string };
    const pools = (await (await a.call('/v1/pools')).json()) as { inventoryVersion: string };
    expect(pools.inventoryVersion).toBe(inventory.version);
    a.advance(2000);
    a.lists['codex-primary'] = [];
    const sync = (await (await a.sync({ reason: 'delete', deletedNames: ['a.json'] })).json()) as {
      version: string;
    };
    const after = (await (await a.call('/v1/pools')).json()) as { inventoryVersion: string };
    expect(after.inventoryVersion).toBe(sync.version);
    expect(after.inventoryVersion).not.toBe(inventory.version);
  });
});
