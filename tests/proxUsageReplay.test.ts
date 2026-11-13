import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { UsageCollector } from '../server/usage/collector';
import { UsageWriter } from '../server/usage/writer';
import { UsageStore, openUsageReader } from '../server/usage/store';
import { subscribeUsage } from '../server/usage/resp';
import { parseReplayPage } from '../server/usage/replay';
import { usagePayload } from './fixtures/usagePayloads';
import { eventually, fakeUsageProxy, FakeUsageClock } from './helpers/usageFakeProxy';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const dir = mkdtempSync('/dev/shm/prox-usage-replay-');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { events: join(dir, 'usage.sqlite'), raw: join(dir, 'usage-raw.sqlite') };
  const proxy = await fakeUsageProxy();
  cleanup.push(() => proxy.close());
  const clock = new FakeUsageClock();
  const rows = (sql: string) => {
    const reader = openUsageReader(paths.events);
    try {
      return reader.query(sql).all();
    } finally {
      reader.close();
    }
  };
  const start = async () => {
    const writer = new UsageWriter();
    cleanup.push(() => writer.close());
    await writer.init(paths, ['test-proxy'], clock.now());
    const collector = new UsageCollector(
      {
        instanceId: 'test-proxy',
        label: 'Test',
        aliases: [],
        publicBasePath: '',
        authScope: 'test',
        upstreamOrigin: proxy.origin,
        managementKeyFile: '/synthetic-key',
      },
      writer,
      { clock, readKey: async () => 'synthetic-key' }
    );
    cleanup.push(() => collector.stop());
    collector.start();
    return { writer, collector };
  };
  const seed = (seq: number, heartbeat = clock.now()) => {
    const store = new UsageStore({ events: paths.events, raw: null });
    store.insert([], 3, {
      cursors: [{ instance: 'test-proxy', cursor: { bootId: proxy.bootId, queueSeq: seq } }],
    });
    store.setMeta('heartbeat:test-proxy', String(heartbeat));
    store.close();
  };
  return { dir, paths, proxy, clock, rows, start, seed };
}

const ready = async (run: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['start']>>) => {
  await eventually(() => run.collector.status.state === 'subscribed', 'completed replay');
  await run.writer.flush();
};

const events = 'SELECT execution_id FROM event_detail ORDER BY execution_id';
const gaps = 'SELECT instance, from_ms, to_ms, reason, missed FROM ingest_gaps ORDER BY id';

describe('usage replay with the real writer and synthetic proxy', () => {
  test('restart recovers the 22:56 overlap while another subscriber prevents legacy queuing', async () => {
    const env = await setup();
    const other = await subscribeUsage({
      origin: env.proxy.origin,
      key: 'synthetic',
      signal: new AbortController().signal,
      onPayload: () => {},
      onActivity: () => {},
    });
    cleanup.push(() => other.unsubscribe());
    const first = await env.start();
    await ready(first);
    env.proxy.emit(usagePayload({ execution_id: 'before-restart' }));
    await eventually(() => first.writer.status.inserted === 1);
    await first.writer.heartbeat('test-proxy', env.clock.now());
    await first.collector.stop();
    await first.writer.close();
    env.proxy.emit(
      usagePayload({ execution_id: 'at-22:56:49.16', timestamp: '2026-11-12T22:56:49.160Z' })
    );
    env.proxy.emit(
      usagePayload({ execution_id: 'at-22:56:49.43', timestamp: '2026-11-12T22:56:49.430Z' })
    );
    expect(env.proxy.queued).toHaveLength(0);
    await env.clock.advance(4_000_000); // Even a stale heartbeat is recoverable with a retained log.
    const second = await env.start();
    await ready(second);
    expect(env.rows(events)).toEqual([
      { execution_id: 'at-22:56:49.16' },
      { execution_id: 'at-22:56:49.43' },
      { execution_id: 'before-restart' },
    ]);
    expect(env.rows(gaps)).toEqual([]);
    expect((await second.writer.resume('test-proxy')).cursor).toEqual({
      bootId: env.proxy.bootId,
      queueSeq: 3,
    });
    expect(env.proxy.log).not.toContain('drain');
  });

  test('retention loss has the exact missed count and interval; retries do not count it again', async () => {
    const env = await setup();
    for (let i = 1; i <= 9; i++) env.proxy.emit(usagePayload({ execution_id: `retained-${i}` }));
    const from = env.clock.now() - 20_000;
    env.seed(3, from);
    env.proxy.pruneThrough(7);
    const run = await env.start();
    await ready(run);
    expect(env.rows(events)).toHaveLength(2);
    expect(env.rows(gaps)).toEqual([
      {
        instance: 'test-proxy',
        from_ms: from,
        to_ms: env.clock.now(),
        reason: 'subscription-dropped',
        missed: 4,
      },
    ]);
    env.proxy.drop();
    await eventually(() => run.collector.status.state === 'backoff');
    expect(env.rows(gaps)).toHaveLength(2); // Permanent loss plus provisional outage.
    await env.clock.advance(1000);
    await eventually(() => run.collector.status.reconnects === 1);
    await ready(run);
    expect(env.rows(gaps)).toHaveLength(1);
    expect(env.rows(events)).toHaveLength(2);
  });

  test('an empty pruned log advances past lost records once', async () => {
    const env = await setup();
    for (let i = 1; i <= 9; i++) env.proxy.emit(usagePayload({ execution_id: `pruned-${i}` }));
    env.seed(3);
    env.proxy.pruneThrough(9);
    const run = await env.start();
    await ready(run);
    expect((await run.writer.resume('test-proxy')).cursor?.queueSeq).toBe(9);
    expect(env.rows(gaps)).toMatchObject([{ missed: 6 }]);
  });

  test('a proxy boot change restarts at zero and records uncountable loss', async () => {
    const env = await setup();
    env.seed(400);
    env.proxy.restart();
    env.proxy.emit(usagePayload({ execution_id: 'new-boot' }));
    const run = await env.start();
    await ready(run);
    expect(env.proxy.replayRequests).toEqual([400, 0]);
    expect(env.rows(events)).toEqual([{ execution_id: 'new-boot' }]);
    expect(env.rows(gaps)).toMatchObject([{ reason: 'proxy-restart', missed: null }]);
    expect((await run.writer.resume('test-proxy')).cursor).toEqual({
      bootId: env.proxy.bootId,
      queueSeq: 1,
    });
  });

  test('pages beyond 1000 while live events arrive, with no missing or duplicate executions', async () => {
    const env = await setup();
    for (let i = 1; i <= 2505; i++) env.proxy.emit(usagePayload({ execution_id: `page-${i}` }));
    let emitted = 2505;
    env.proxy.onReplay = () => {
      for (let i = 0; i < 10; i++) {
        emitted++;
        env.proxy.emit(usagePayload({ execution_id: `page-${emitted}` }));
      }
    };
    const run = await env.start();
    await ready(run);
    await eventually(() => run.writer.status.inserted === emitted);
    env.proxy.onReplay = null;
    await run.writer.flush();
    expect(env.proxy.replayRequests).toEqual([0, 1000, 2000]);
    expect(env.rows(events)).toHaveLength(emitted);
    expect(
      new Set(env.rows(events).map((row) => (row as { execution_id: string }).execution_id)).size
    ).toBe(emitted);
    expect(env.rows(gaps)).toEqual([]);
    expect((await run.writer.resume('test-proxy')).cursor?.queueSeq).toBe(emitted);
    // A second resume has no new inserts, even if the previous process had accepted overlap.
    await run.collector.stop();
    await run.writer.close();
    const second = await env.start();
    await ready(second);
    expect(second.writer.status.inserted).toBe(0);
    expect(env.rows(events)).toHaveLength(emitted);
  });

  for (const missing of [0, 25]) {
    test(`pruning between replay pages counts only ${missing} undelivered records before the live suffix`, async () => {
      const env = await setup();
      // The first page ends at 1000. Any extra preloaded records were never subscribed.
      for (let i = 1; i <= 1000 + missing; i++) {
        env.proxy.emit(usagePayload({ execution_id: `pruning-${i}` }));
      }
      env.proxy.onReplay = () => {
        env.proxy.onReplay = null;
        for (let i = 1001 + missing; i <= 1100; i++) {
          env.proxy.emit(usagePayload({ execution_id: `pruning-${i}` }));
        }
        // All records disappear from replay after the first page snapshot. The live
        // suffix must remain covered even though its cursor was withheld during replay.
        env.proxy.pruneThrough(1100);
      };
      const run = await env.start();
      await ready(run);
      expect(env.proxy.replayRequests).toEqual([0, 1000]);
      expect(env.rows(events)).toHaveLength(1100 - missing);
      expect(run.writer.status.inserted).toBe(1100 - missing);
      expect((await run.writer.resume('test-proxy')).cursor?.queueSeq).toBe(1100);
      if (missing === 0) expect(env.rows(gaps)).toEqual([]);
      else
        expect(env.rows(gaps)).toMatchObject([
          { instance: 'test-proxy', reason: 'subscription-dropped', missed: missing },
        ]);
    });
  }

  test('400 backs off, preserves the durable cursor and never falls back to popping', async () => {
    const env = await setup();
    env.seed(3);
    env.proxy.replayStatus = 400;
    const run = await env.start();
    await eventually(() => run.collector.status.state === 'backoff');
    expect((await run.writer.resume('test-proxy')).cursor?.queueSeq).toBe(3);
    expect(env.proxy.log).not.toContain('drain');
    expect(env.rows(gaps)).toHaveLength(1); // Unresolved coverage stays visible.
    env.proxy.sequence = 3;
    env.proxy.replayStatus = 200;
    await env.clock.advance(1000);
    await ready(run);
    expect(env.rows(gaps)).toEqual([]);
  });

  test('raw and rejected replay records still advance the page cursor without storing metadata', async () => {
    const env = await setup();
    env.proxy.emit('raw-record');
    env.proxy.emit({ unexpected: true });
    env.proxy.emit(usagePayload({ execution_id: 'valid' }));
    const run = await env.start();
    await ready(run);
    expect(run.writer.status.rejected).toBe(2);
    expect(env.rows(events)).toEqual([{ execution_id: 'valid' }]);
    expect((await run.writer.resume('test-proxy')).cursor?.queueSeq).toBe(3);
    const raw = new Database(env.paths.raw, { readonly: true });
    try {
      const row = raw.query<{ payload: Uint8Array }, []>('SELECT payload FROM payloads').get()!;
      const { gunzipSync } = await import('node:zlib');
      const payload = JSON.parse(gunzipSync(row.payload).toString());
      expect(payload).not.toHaveProperty('queue_seq');
      expect(payload).not.toHaveProperty('boot_id');
    } finally {
      raw.close();
    }
  });
});

test('replay response validation refuses unsafe cursors and malformed pages', () => {
  for (const value of [
    null,
    [],
    {},
    { boot_id: 'boot', oldest_seq: 1, next_seq: 0, records: [{ queue_seq: 0, payload: {} }] },
    { boot_id: 'boot', oldest_seq: 1, next_seq: 2, records: [] },
    { boot_id: 'boot', oldest_seq: 1, next_seq: Number.MAX_SAFE_INTEGER + 1, records: [] },
  ]) {
    expect(() => parseReplayPage(value, 0)).toThrow('Invalid usage replay response');
  }
});

test('SIGKILL after the event/cursor writes but before COMMIT rolls back both, then replay recovers', async () => {
  const env = await setup();
  env.seed(1);
  env.proxy.sequence = 1;
  env.proxy.emit(usagePayload({ execution_id: 'interrupted-commit' }));
  const script = join(env.dir, 'crash-before-commit.ts');
  // Wrap only the isolated child's transaction callback. SQLite has executed every write,
  // including the cursor and gap, when the parent kills it before the COMMIT statement.
  writeFileSync(
    script,
    `
    import { Database } from 'bun:sqlite';
    import { writeSync } from 'node:fs';
    import { UsageStore } from ${JSON.stringify(join(import.meta.dir, '../server/usage/store.ts'))};
    import { normalizeUsagePayload } from ${JSON.stringify(join(import.meta.dir, '../server/usage/normalize.ts'))};
    const original = Database.prototype.transaction;
    let armed = false;
    Database.prototype.transaction = function (fn) {
      return original.call(this, (...args) => {
        const result = fn(...args);
        if (armed) {
          writeSync(1, 'before-commit\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return result;
      });
    };
    const store = new UsageStore(${JSON.stringify({ events: env.paths.events, raw: null })});
    const result = normalizeUsagePayload(${JSON.stringify(JSON.stringify(usagePayload({ execution_id: 'interrupted-commit' })))});
    if (result.kind !== 'event') throw new Error('Invalid synthetic fixture');
    armed = true;
    store.insert([{ event: result.event, raw: result.raw }], 3,
      { cursors: [{ instance: 'test-proxy', cursor: ${JSON.stringify({ bootId: env.proxy.bootId, queueSeq: 2 })} }],
      gap: { instance: 'test-proxy', fromMs: 1, toMs: 2, reason: 'subscription-dropped', missed: 1 } });
  `
  );
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise<string>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Child did not reach COMMIT boundary')), 5000);
      }),
    ]);
    expect(output).toContain('before-commit');
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    await child.exited;
    reader.releaseLock();
  }
  const store = new UsageStore({ events: env.paths.events, raw: null });
  expect(store.getCursor('test-proxy')).toEqual({ bootId: env.proxy.bootId, queueSeq: 1 });
  expect(store.gapCount()).toBe(0);
  store.close();
  expect(env.rows(events)).toEqual([]);
  const run = await env.start();
  await ready(run);
  expect(env.rows(events)).toEqual([{ execution_id: 'interrupted-commit' }]);
  expect((await run.writer.resume('test-proxy')).cursor?.queueSeq).toBe(2);
  expect(env.rows(gaps)).toEqual([]);
});

test('the fake proxy exposes numbered non-destructive pages and rejects malformed cursors', async () => {
  const env = await setup();
  env.proxy.emit(usagePayload({ execution_id: 'endpoint-contract' }));
  const get = (query: string) =>
    fetch(`${env.proxy.origin}/v8/management/observability/usage/queue?${query}`);
  for (const query of [
    'after_seq=-1',
    'after_seq=1.5',
    'after_seq=wat',
    'after_seq=%ZZ',
    'after_seq=0&count=0',
    'after_seq=0&count=-1',
  ]) {
    expect((await get(query)).status).toBe(400);
  }
  const first = await (await get('after_seq=0')).json();
  expect(first).toMatchObject({
    boot_id: env.proxy.bootId,
    oldest_seq: 1,
    next_seq: 1,
    records: [{ queue_seq: 1, payload: { queue_seq: 1, boot_id: env.proxy.bootId } }],
  });
  expect(await (await get('after_seq=0')).json()).toEqual(first);
  expect(env.proxy.queued).toHaveLength(1);
});
