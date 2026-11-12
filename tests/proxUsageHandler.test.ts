import { afterEach, expect, test } from 'bun:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnalyticsHandler } from '../server/usage/handler';
import { parseRateBook } from '../server/usage/rates';
import { analyticsStore, event, query, rates, rateState } from './helpers/usageAnalytics';

let fixture: ReturnType<typeof analyticsStore>;
let handler: ReturnType<typeof createAnalyticsHandler>;
afterEach(() => {
  handler?.close();
  fixture?.close();
});
const request = (path = '/v1/analytics', key = 'synthetic-key', body = JSON.stringify(query())) =>
  new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body,
  });
function setup() {
  const f = (fixture = analyticsStore());
  writeFileSync(join(f.directory, 'key'), 'synthetic-key');
  f.insert([event(1)]);
  return f;
}
test('real query workers, bearer auth, alias, validation and exactly one rate snapshot per response', async () => {
  const f = setup();
  let loads = 0;
  const alternate = parseRateBook({
    version: 1,
    models: { 'claude-test-4': { ...rates, input: 999 } },
  });
  handler = createAnalyticsHandler({
    dbPath: f.path,
    keyFile: join(f.directory, 'key'),
    rateBook: { load: () => rateState(++loads === 1 ? undefined : alternate) },
  });
  expect((await handler(request('/v1/analytics', 'wrong'))).status).toBe(401);
  expect((await handler(request('/unknown'))).status).toBe(404);
  expect((await handler(new Request('http://127.0.0.1/v1/analytics'))).status).toBe(405);
  expect((await handler(request('/v1/analytics', 'synthetic-key', '{}'))).status).toBe(400);
  expect(
    (await handler(request('/v1/analytics', 'synthetic-key', JSON.stringify(query()) + '{}')))
      .status
  ).toBe(400);
  expect(loads).toBe(0);
  const first = await handler(request());
  expect(first.status).toBe(200);
  expect(first.headers.get('Cache-Control')).toBe('no-store');
  const body = await first.json();
  expect(body.schema_version).toBe(1);
  expect(body.summary.calls).toBe(1);
  expect(body.requests.items[0].cost.usd).toBe(body.summary.cost.usd);
  expect(loads).toBe(1);
  const second = await handler(request('/v0/management/monitoring/prox-analytics'));
  expect(second.status).toBe(200);
  const next = await second.json();
  expect(next.summary.cost.usd).toBeGreaterThan(body.summary.cost.usd);
  expect(next.coverage.price_revision).not.toBe(body.coverage.price_revision);
  expect(loads).toBe(2);
});
test('missing rate book returns unpriced rows and a coverage limitation', async () => {
  const f = setup();
  handler = createAnalyticsHandler({
    dbPath: f.path,
    keyFile: join(f.directory, 'key'),
    rateBookPath: join(f.directory, 'missing'),
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.summary.cost.status).toBe('unpriced');
  expect(body.coverage.limitations.join('\n')).toContain('rate book failed');
});
test('worker errors are safe, closed handlers reject admission, missing key fails closed', async () => {
  const f = setup();
  handler = createAnalyticsHandler({
    dbPath: join(f.directory, 'missing'),
    keyFile: join(f.directory, 'key'),
  });
  const response = await handler(request());
  expect(response.status).toBe(500);
  expect(await response.text()).toBe('{"error":"Analytics query failed"}');
  handler.close();
  expect((await handler(request())).status).toBe(503);
  handler = createAnalyticsHandler({ dbPath: f.path, keyFile: join(f.directory, 'missing-key') });
  expect((await handler(request())).status).toBe(503);
});
test('worker entry builds and RPC also works as a child process', async () => {
  const f = setup();
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../server/usage/query.worker.ts')],
    target: 'bun',
    outdir: f.directory,
  });
  expect(result.success).toBe(true);
  const replies: unknown[] = [];
  let accept!: (value: unknown) => void;
  const reply = new Promise((resolve) => {
    accept = resolve;
  });
  const child = Bun.spawn([process.execPath, join(f.directory, 'query.worker.js')], {
    ipc(message) {
      replies.push(message);
      accept(message);
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    child.send({
      id: 1,
      kind: 'analytics',
      body: { dbPath: f.path, query: query(), deadline: Date.now() + 30000, rates: rateState() },
    });
    const response = (await reply) as { ok: boolean; body: string };
    expect(response.ok).toBe(true);
    expect(JSON.parse(response.body).summary.calls).toBe(1);
    expect(readFileSync(join(f.directory, 'query.worker.js'), 'utf8')).toContain('bun:sqlite');
  } finally {
    child.kill();
    await child.exited;
  }
});
test('streamed JSON body limit, cancellation, and active worker termination free the lane', async () => {
  const f = setup();
  const workerPath = join(f.directory, 'blocking.worker.ts');
  writeFileSync(
    workerPath,
    `self.onmessage = ({data}) => {
    if (data.body.query.search === 'block') { while (true) {} }
    self.postMessage({id: data.id, ok: true, body: '{"ok":true}'});
  };`
  );
  handler = createAnalyticsHandler({
    dbPath: f.path,
    keyFile: join(f.directory, 'key'),
    workerPath,
    rateBook: { load: () => rateState() },
  });
  expect(
    (await handler(request('/v1/analytics', 'synthetic-key', ' '.repeat((1 << 20) + 1)))).status
  ).toBe(400);
  const cancelBody = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  });
  const pendingBody = handler(
    new Request('http://127.0.0.1/v1/analytics', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-key' },
      body: stream,
      signal: cancelBody.signal,
    })
  );
  cancelBody.abort();
  expect((await pendingBody).status).toBe(499);
  const cancel = new AbortController();
  const blocked = handler(
    new Request('http://127.0.0.1/v1/analytics', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-key' },
      body: JSON.stringify(query({ search: 'block' })),
      signal: cancel.signal,
    })
  );
  await Bun.sleep(40);
  cancel.abort();
  expect((await blocked).status).toBe(499);
  const next = await handler(
    request('/v1/analytics', 'synthetic-key', JSON.stringify(query({ search: 'next' })))
  );
  expect(next.status).toBe(200);
  expect(await next.json()).toEqual({ ok: true });
});
