import { expect, test } from 'bun:test';
import { createAnalyticsLanes } from '../server/usage/lanes';
import { query } from './helpers/usageAnalytics';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
test('CPAMP fast-query admission: a queued search never delays a plain view', async () => {
  const started: string[] = [];
  const first = deferred<string>();
  const lanes = createAnalyticsLanes({
    fast: async () => {
      started.push('fast');
      return 'plain';
    },
    search: async (q) => {
      started.push(q.search!);
      return q.search === 'first' ? first.promise : 'second';
    },
  });
  try {
    const a = lanes.query(query({ search: 'first' }));
    const b = lanes.query(query({ search: 'second' }));
    expect(await lanes.query(query())).toBe('plain');
    expect(started).toEqual(['first', 'fast']);
    first.resolve('first');
    expect(await a).toBe('first');
    expect(await b).toBe('second');
    expect(started).toEqual(['first', 'fast', 'second']);
  } finally {
    lanes.close();
  }
});
test('one active and eight waiting per lane, immediate 503 beyond the bound', async () => {
  const release = deferred<string>();
  const execute = async () => release.promise;
  const lanes = createAnalyticsLanes({ fast: execute, search: execute });
  try {
    const pending = Array.from({ length: 9 }, () => lanes.query(query()));
    await expect(lanes.query(query())).rejects.toMatchObject({ status: 503 });
    // Search has a distinct allowance, despite a full fast lane.
    const search = lanes.query(query({ search: 'x' }));
    release.resolve('ok');
    expect(await Promise.all([...pending, search])).toHaveLength(10);
  } finally {
    lanes.close();
  }
});
test('deadline includes wait, expired queued jobs never execute and free waiting space', async () => {
  const release = deferred<string>();
  const started: string[] = [];
  const execute = async (q: ReturnType<typeof query>) => {
    started.push(q.search!);
    return release.promise;
  };
  const lanes = createAnalyticsLanes({ fast: execute, search: execute });
  try {
    const active = lanes.query(query({ search: 'active' }));
    const queued = lanes.query(query({ search: 'expires' }), { deadline: Date.now() + 20 });
    await expect(queued).rejects.toMatchObject({ status: 504 });
    const next = lanes.query(query({ search: 'next' }));
    release.resolve('done');
    await active;
    await next;
    expect(started).toEqual(['active', 'next']);
  } finally {
    lanes.close();
  }
});
test('active deadlines abort execution and cancellation removes queued requests', async () => {
  const observed = deferred<void>();
  const lanes = createAnalyticsLanes({
    fast: async (_q, _deadline, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observed.resolve();
            reject(signal.reason);
          },
          { once: true }
        );
      }),
    search: async () => 'ok',
  });
  try {
    const active = lanes.query(query(), { deadline: Date.now() + 30 });
    const cancel = new AbortController();
    const queued = lanes.query(query(), { signal: cancel.signal });
    cancel.abort();
    await expect(queued).rejects.toMatchObject({ status: 499 });
    await expect(active).rejects.toMatchObject({ status: 504 });
    await observed.promise;
    expect(await lanes.query(query({ search: 'unblocked' }))).toBe('ok');
  } finally {
    lanes.close();
  }
});
