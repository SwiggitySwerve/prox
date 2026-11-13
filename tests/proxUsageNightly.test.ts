import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNightly } from '../scripts/usage-nightly';
import { quietGate } from './helpers/usageParity';
import { generateParityEvidence } from './helpers/usageParityEvidence';
import { Socket, connect, createConnection } from 'node:net';
import { takeBlockedTestPorts } from './support/noLivePorts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function fixture(
  options: {
    fail?: string;
    backup?: boolean;
    at?: number;
    delay?: number;
    unfinishedSuccess?: boolean;
    postDelay?: number;
    parityExit?: number;
  } = {}
) {
  const root = mkdtempSync('/dev/shm/prox-nightly-test-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, 'synthetic-nightly-key');
  let now = options.at ?? Date.UTC(2026, 10, 13, 4, 20);
  const calls: string[] = [];
  const tokens: string[] = [];
  let job: {
    id: number;
    kind: string;
    state: string;
    startedAtMs: number;
    clientToken?: string;
    finishedAtMs: number | null;
  } | null = null;
  let polls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-nightly-key');
      const path = new URL(request.url).pathname;
      if (path === '/v1/jobs/cancel') {
        expect(await request.json()).toEqual({ jobId: job?.id, clientToken: job?.clientToken });
        calls.push('cancel');
        return Response.json({ job });
      }
      if (request.method === 'POST') {
        const { kind, clientToken } = (await request.json()) as {
          kind: string;
          clientToken: string;
        };
        tokens.push(clientToken);
        calls.push(`start-${kind}`);
        expect(job === null || job.finishedAtMs !== null).toBe(true);
        job = {
          id: (job?.id ?? 0) + 1,
          kind,
          state: 'running',
          clientToken,
          startedAtMs: now,
          finishedAtMs: null,
        };
        polls = 0;
        now += options.postDelay ?? 0;
      } else {
        calls.push(`poll-${job?.kind}`);
        polls++;
        if (job) {
          job.state = options.fail === job.kind ? 'failed' : 'succeeded';
          job.finishedAtMs = options.unfinishedSuccess && polls === 1 ? null : now;
        }
      }
      return Response.json({ job });
    },
  });
  cleanups.push(() => server.stop(true));
  const signal = new AbortController().signal;
  const run = () =>
    runNightly(
      {
        url: `http://127.0.0.1:${server.port}`,
        keyFile,
        backupEnabled: options.backup ?? false,
        pollMs: options.delay ?? 1000,
      },
      {
        signal,
        now: () => now,
        gate: quietGate(signal),
        sleep: async (ms) => {
          now += ms;
        },
        parity: async (deadline, abort) => {
          expect(new Date(deadline).toISOString()).toBe('2026-11-13T12:00:00.000Z');
          expect(abort.aborted).toBe(false);
          calls.push('parity');
          return options.parityExit ?? 0;
        },
      }
    );
  return { run, calls, tokens };
}
test('nightly chain waits for terminal success and cleanup before every subsequent step', async () => {
  const f = fixture({ backup: true, unfinishedSuccess: true });
  expect(await f.run()).toMatchObject({
    status: 'succeeded',
    completed: ['prune', 'reconcile', 'backup', 'parity'],
  });
  expect(new Set(f.tokens).size).toBe(f.tokens.length);
  expect(f.tokens.every((token) => /^[a-f0-9-]{36}$/.test(token))).toBe(true);
  expect(f.calls).toEqual([
    'start-prune',
    'poll-prune',
    'poll-prune',
    'start-reconcile',
    'poll-reconcile',
    'poll-reconcile',
    'start-backup',
    'poll-backup',
    'poll-backup',
    'parity',
  ]);
});
test('backup is skipped by default; parity follows completed reconcile', async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    status: 'succeeded',
    backup: 'skipped',
    completed: ['prune', 'reconcile', 'parity'],
  });
  expect(f.calls).toEqual([
    'start-prune',
    'poll-prune',
    'start-reconcile',
    'poll-reconcile',
    'parity',
  ]);
});
test('any failed job stops the chain before later jobs or parity', async () => {
  for (const fail of ['prune', 'reconcile', 'backup']) {
    const f = fixture({ fail, backup: true });
    expect((await f.run()).status).toBe('failed');
    expect(f.calls).not.toContain('parity');
    if (fail === 'prune') expect(f.calls).not.toContain('start-reconcile');
    if (fail !== 'backup') expect(f.calls).not.toContain('start-backup');
  }
});
test('delayed starts in forbidden windows or after noon admit no jobs', async () => {
  for (const [hour, minute] of [
    [1, 0],
    [3, 59],
    [12, 0],
    [12, 20],
    [12, 50],
    [23, 0],
  ]) {
    const f = fixture({ at: Date.UTC(2026, 10, 13, hour, minute) });
    expect((await f.run()).status).toBe('incomplete');
    expect(f.calls).toEqual([]);
  }
});
test('long polling waits stop at noon or forbidden boundary and cancel the active job', async () => {
  for (const [hour, minute] of [
    [0, 59],
    [11, 59],
  ]) {
    const f = fixture({ at: Date.UTC(2026, 10, 13, hour, minute), delay: 120000 });
    expect(await f.run()).toMatchObject({
      status: 'incomplete',
      cancellation: 'requested',
      completed: [],
    });
    expect(f.calls).toEqual(['start-prune', 'cancel']);
  }
});
test('fixture evidence contacts only its synthetic job server', async () => {
  const root = mkdtempSync('/dev/shm/prox-evidence-test-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  await generateParityEvidence(root);
  const report = JSON.parse(readFileSync(join(root, 'synthetic-events.json'), 'utf8'));
  expect(report.reconcile.status).toBe('not-confirmed');
  expect(report.counts.unexplained).toBe(0);
  expect(report.targets.prox).not.toContain(':18320');
});
test('test network guard blocks live ports before fetch, Node or Bun TCP admission', () => {
  for (const port of [18317, 18320, 8317, 8319]) {
    expect(() => fetch(`http://127.0.0.1:${port}/v1/jobs`)).toThrow(
      'Tests must not contact live port'
    );
    expect(() => new Socket().connect(port, '127.0.0.1')).toThrow(
      'Tests must not contact live port'
    );
    expect(() =>
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {}, open() {} } })
    ).toThrow('Tests must not contact live port');
    expect(() => connect(port, '127.0.0.1')).toThrow('Tests must not contact live port');
    expect(() => createConnection({ port, host: '127.0.0.1' })).toThrow(
      'Tests must not contact live port'
    );
    expect(takeBlockedTestPorts()).toEqual([port, port, port, port, port]);
  }
});

test('a cutoff during submission retains the admitted job ID for cancellation', async () => {
  const f = fixture({ at: Date.UTC(2026, 10, 13, 11, 59, 59), postDelay: 2000 });
  expect(await f.run()).toMatchObject({ status: 'incomplete', cancellation: 'requested' });
  expect(f.calls).toEqual(['start-prune', 'cancel']);
});
test('failed or incomplete parity cannot make the nightly chain pass', async () => {
  for (const [exit, status] of [
    [1, 'failed'],
    [2, 'incomplete'],
    [130, 'failed'],
  ] as const) {
    const f = fixture({ parityExit: exit });
    const report = await f.run();
    expect(report.status).toBe(status);
    expect(report.completed).toEqual(['prune', 'reconcile']);
  }
});

// Hold a real HTTP response body in flight while the window/interrupt fires.
// The submit must finish reading its accepted ID using its own bounded signal.
for (const stop of ['noon', 'interrupt', 'broken-response'] as const) {
  test(`in-flight submission retains or recovers cancellation ownership on ${stop}`, async () => {
    const root = mkdtempSync('/dev/shm/prox-nightly-inflight-');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const keyFile = join(root, 'key');
    writeFileSync(keyFile, 'synthetic-key');
    const controller = new AbortController();
    let now =
      stop === 'noon' ? Date.UTC(2026, 10, 13, 11, 59, 59, 990) : Date.UTC(2026, 10, 13, 4, 20);
    const job = {
      id: 71,
      kind: 'prune',
      state: 'running',
      startedAtMs: now,
      finishedAtMs: null,
      clientToken: undefined as string | undefined,
    };
    const calls: string[] = [];
    let broken = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-key');
        const path = new URL(request.url).pathname;
        if (path === '/v1/jobs/cancel') {
          expect(await request.json()).toEqual({ jobId: 71, clientToken: job.clientToken });
          calls.push('cancel');
          return Response.json({ job });
        }
        if (request.method === 'GET') {
          calls.push('recover');
          return Response.json({ job });
        }
        calls.push('submit');
        job.clientToken = ((await request.json()) as { clientToken: string }).clientToken;
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"job":'));
              setTimeout(() => {
                if (stop === 'interrupt') controller.abort();
                if (stop === 'noon') now = Date.UTC(2026, 10, 13, 12);
              }, 1);
              setTimeout(() => {
                if (stop === 'broken-response') {
                  broken = true;
                  stream.error(new Error('synthetic connection lost'));
                } else {
                  stream.enqueue(new TextEncoder().encode(`${JSON.stringify(job)}}`));
                  stream.close();
                }
              }, 40);
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      },
    });
    cleanups.push(() => server.stop(true));
    const report = await runNightly(
      { url: `http://127.0.0.1:${server.port}`, keyFile, backupEnabled: false, pollMs: 1 },
      {
        signal: controller.signal,
        now: () => now,
        gate: quietGate(controller.signal),
        parity: async () => {
          throw new Error('Must not reach parity');
        },
      }
    );
    expect(report).toMatchObject({
      status: stop === 'noon' ? 'incomplete' : 'failed',
      cancellation: 'requested',
      completed: [],
    });
    expect(calls).toEqual(
      stop === 'broken-response' ? ['submit', 'recover', 'cancel'] : ['submit', 'cancel']
    );
    expect(broken).toBe(stop === 'broken-response');
    if (stop === 'broken-response') expect(report.recovery).toBe('owned-job');
  });
}

test('ambiguous recovery never cancels newer operator jobs without the exact token or terminal jobs', async () => {
  for (const variant of [
    'operator-no-token',
    'operator-other-token',
    'no-job',
    'different-kind',
    'terminal',
    '409',
  ] as const) {
    const root = mkdtempSync('/dev/shm/prox-nightly-recovery-');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const keyFile = join(root, 'key');
    writeFileSync(keyFile, 'synthetic-key');
    const now = Date.UTC(2026, 10, 13, 4, 20);
    const calls: string[] = [];
    let submittedToken = '';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith('/cancel')) {
          calls.push('cancel');
          return Response.json({});
        }
        if (request.method === 'POST') {
          calls.push('submit');
          submittedToken = ((await request.json()) as { clientToken: string }).clientToken;
          return variant === '409' ? new Response(null, { status: 409 }) : new Response('{"job":');
        }
        calls.push('recover');
        if (variant === 'no-job') return Response.json({ job: null });
        return Response.json({
          job: {
            id: 99,
            clientToken:
              variant === 'operator-other-token'
                ? 'operator-token'
                : variant === 'operator-no-token'
                  ? undefined
                  : submittedToken,
            kind: variant === 'different-kind' ? 'backup' : 'prune',
            startedAtMs: now + 500,
            state: variant === 'terminal' ? 'succeeded' : 'running',
            finishedAtMs: variant === 'terminal' ? now : null,
          },
        });
      },
    });
    cleanups.push(() => server.stop(true));
    const signal = new AbortController().signal;
    const report = await runNightly(
      { url: `http://127.0.0.1:${server.port}`, keyFile, backupEnabled: false, pollMs: 1 },
      { signal, now: () => now, gate: quietGate(signal) }
    );
    expect(report.status).toBe('failed');
    if (
      variant === 'operator-no-token' ||
      variant === 'operator-other-token' ||
      variant === 'no-job'
    ) {
      expect(report.recovery).toBe('no-owned-job');
      expect(report.error).toContain('no job with the submission token');
    }
    if (variant === '409') {
      expect(report.refused).toEqual({ kind: 'prune', status: 409 });
      expect(report.error).toBe('Nightly prune admission refused (HTTP 409)');
      expect(report.recovery).toBeUndefined();
      expect(report.cancellation).toBeUndefined();
    }
    expect(calls).toEqual(variant === '409' ? ['submit'] : ['submit', 'recover']);
  }
});
