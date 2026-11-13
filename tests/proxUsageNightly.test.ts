import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNightly } from '../scripts/usage-nightly';
import { quietGate } from './helpers/usageParity';
import { generateParityEvidence } from './helpers/usageParityEvidence';
import { Socket } from 'node:net';
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
  let job: { id: number; kind: string; state: string; finishedAtMs: number | null } | null = null;
  let polls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-nightly-key');
      const path = new URL(request.url).pathname;
      if (path === '/v1/jobs/cancel') {
        calls.push('cancel');
        return Response.json({ job });
      }
      if (request.method === 'POST') {
        const { kind } = (await request.json()) as { kind: string };
        calls.push(`start-${kind}`);
        expect(job === null || job.finishedAtMs !== null).toBe(true);
        job = { id: (job?.id ?? 0) + 1, kind, state: 'running', finishedAtMs: null };
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
  return { run, calls };
}
test('nightly chain waits for terminal success and cleanup before every subsequent step', async () => {
  const f = fixture({ backup: true, unfinishedSuccess: true });
  expect(await f.run()).toMatchObject({
    status: 'succeeded',
    completed: ['prune', 'reconcile', 'backup', 'parity'],
  });
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
    expect(takeBlockedTestPorts()).toEqual([port, port, port]);
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
