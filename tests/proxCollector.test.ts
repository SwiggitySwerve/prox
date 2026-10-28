import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaCollector } from '../server/quota/collector';
import { QuotaStore } from '../server/quota/store';
import { MANUAL_REFRESH_INTERVAL_MS, REFRESH_INTERVAL_MS } from '../server/quota/types';
import type { PoolProviderId } from '../src/domain/quotaPool/types';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
} from '../src/utils/quota/constants';

const NOW = 1_800_000_000_000;
const RESET = NOW + 86_400_000;
const claudeBody = {
  five_hour: { utilization: 25, resets_at: new Date(RESET).toISOString() },
  seven_day: { utilization: '60', resets_at: new Date(RESET).toISOString() },
  seven_day_sonnet: { utilization: 99 },
};
const codexBody = {
  rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: RESET / 1000 },
    secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: RESET / 1000 },
  },
  code_review_rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000 } },
};
const credential = (provider: PoolProviderId, index = 'synthetic-index', disabled = false) => ({
  provider,
  type: provider,
  auth_index: index,
  name: `${index}.json`,
  email: 'synthetic@example.test',
  disabled,
});
interface CapturedRequest {
  provider: PoolProviderId;
  url: URL;
  init: RequestInit;
  body: Record<string, unknown> | null;
}
const cleanups: (() => void)[] = [];
function harness(handler?: (request: CapturedRequest) => Promise<Response> | Response) {
  const root = mkdtempSync(join(tmpdir(), 'prox-collector-'));
  const keyFile = join(root, 'management-key');
  writeFileSync(keyFile, 'synthetic-management-key\n', { mode: 0o600 });
  const store = new QuotaStore(join(root, 'data', 'quota.sqlite'));
  let clock = NOW;
  const calls: CapturedRequest[] = [];
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const request: CapturedRequest = {
        provider: url.port === '8319' ? 'claude' : 'codex',
        url,
        init: init ?? {},
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(request);
      return handler ? handler(request) : respond(request);
    },
    { preconnect: () => {} }
  ) satisfies typeof fetch;
  const collector = new QuotaCollector(store, { keyFile, fetcher, now: () => clock });
  cleanups.push(() => {
    collector.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    collector,
    calls,
    keyFile,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
function respond(request: CapturedRequest): Response {
  if (request.url.pathname.endsWith('/credentials')) {
    return Response.json({ files: [credential(request.provider)] });
  }
  return Response.json({
    status_code: 200,
    body: request.provider === 'claude' ? JSON.stringify(claudeBody) : codexBody,
  });
}
function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('QuotaCollector', () => {
  test('polls every five minutes and stop cancels the scheduled poll', async () => {
    const originalTimeout = globalThis.setTimeout;
    const scheduled: { fire: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (handler, delay, ...args) => {
        if (delay !== REFRESH_INTERVAL_MS) return originalTimeout(handler, delay, ...args);
        const timer = originalTimeout(() => {}, 3_600_000);
        scheduled.push({
          timer,
          fire: () => {
            clearTimeout(timer);
            if (typeof handler === 'function') handler(...args);
          },
        });
        return timer;
      }
    );
    const clearSpy = spyOn(globalThis, 'clearTimeout');
    const { collector, calls, advance } = harness();
    try {
      collector.start();
      await collector.refresh();
      expect(scheduled).toHaveLength(1);
      expect(calls).toHaveLength(5);
      advance(REFRESH_INTERVAL_MS);
      scheduled[0].fire();
      await collector.refresh();
      expect(calls).toHaveLength(9);
      expect(scheduled).toHaveLength(2);
      expect(collector.nextRefreshAtMs).toBe(NOW + 2 * REFRESH_INTERVAL_MS);
      collector.stop();
      expect(clearSpy).toHaveBeenCalledWith(scheduled[1].timer);
    } finally {
      collector.stop();
      for (const { timer } of scheduled) clearTimeout(timer);
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test('request deadlines abort quota calls and expose only provider-level errors', async () => {
    const deadline = new AbortController();
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(() => deadline.signal);
    const entered = deferred();
    let active = 0;
    const { collector, store } = harness(async (request) => {
      if (!request.body) return respond(request);
      active++;
      if (active === 2) entered.release();
      await new Promise<void>((_resolve, reject) => {
        request.init.signal?.addEventListener(
          'abort',
          () => reject(new Error('synthetic-private-token')),
          { once: true }
        );
      });
      return respond(request);
    });
    try {
      const pending = collector.refresh();
      await entered.promise;
      deadline.abort();
      await pending;
      expect(timeoutSpy).toHaveBeenCalledWith(20_000);
      expect(store.listSamples(NOW, NOW)).toEqual([]);
      expect(store.listAccounts().every((account) => account.lastErrorAtMs === NOW)).toBe(true);
      expect(collector.issues).toEqual([
        { provider: 'claude', code: 'quota-unavailable' },
        { provider: 'codex', code: 'quota-unavailable' },
      ]);
    } finally {
      deadline.abort();
      timeoutSpy.mockRestore();
    }
  });

  test('uses only read-only v8 quota calls and shared general window parsing', async () => {
    const { collector, store, calls } = harness();
    expect(collector.nextRefreshAtMs).toBe(NOW);
    await collector.refresh();
    expect(collector.issues).toEqual([]);
    expect(collector.lastRefreshAtMs).toBe(NOW);
    expect(collector.nextRefreshAtMs).toBe(NOW + REFRESH_INTERVAL_MS);
    const accounts = store.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].id).toMatch(/^claude:[a-f0-9]{64}$/);
    expect(accounts[1].id).toMatch(/^codex:[a-f0-9]{64}$/);
    expect(accounts.every((account) => !account.id.includes('synthetic-index'))).toBe(true);
    const samples = store.listSamples(NOW, NOW);
    expect(samples).toHaveLength(4);
    expect(
      samples.map((sample) => [
        sample.accountId.split(':')[0],
        sample.window,
        sample.remainingPercent,
        sample.periodHours,
        sample.resetAtMs,
      ])
    ).toEqual([
      ['claude', 'five-hour', 75, 5, RESET],
      ['claude', 'weekly', 40, 168, RESET],
      ['codex', 'five-hour', 80, 5, RESET],
      ['codex', 'weekly', 90, 168, RESET],
    ]);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get('authorization')).toBe(
        'Bearer synthetic-management-key'
      );
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.redirect).toBe('error');
      if (call.body) {
        expect(call.url.pathname).toBe('/v8/management/requests/api-call');
        expect(call.init.method).toBe('POST');
        expect(call.body).toEqual({
          authIndex: 'synthetic-index',
          method: 'GET',
          url:
            call.provider === 'codex'
              ? CODEX_USAGE_URL
              : call.body.url === CLAUDE_PROFILE_URL
                ? CLAUDE_PROFILE_URL
                : CLAUDE_USAGE_URL,
          header: expect.objectContaining({ Authorization: 'Bearer $TOKEN$' }),
        });
      } else {
        expect(call.url.pathname).toBe('/v8/management/credentials');
        expect(call.init.method).toBe('GET');
        expect(call.url.search).toBe('');
      }
    }
  });

  test('keeps the latest reading of every reported window per account', async () => {
    const { collector, store } = harness();
    await collector.refresh();
    const [claude, codex] = store.listAccounts();
    const view = (id: string) =>
      (collector.windows.get(id) ?? []).map(({ id, remainingPercent, resetAtMs }) => [
        id,
        remainingPercent,
        resetAtMs,
      ]);
    expect(view(claude.id)).toEqual([
      ['five-hour', 75, RESET],
      ['seven-day', 40, RESET],
      ['seven-day-sonnet', 1, null],
    ]);
    expect(view(codex.id).map(([id]) => id)).toEqual(
      expect.arrayContaining(['five-hour', 'weekly'])
    );
    expect(view(codex.id)).toHaveLength(3);
    expect(collector.windows.get(claude.id)?.[2].labelKey).toBe('claude_quota.seven_day_sonnet');
  });

  test('skips disabled accounts, ignores other providers, and keeps identities stable after rename', async () => {
    let renamed = false;
    const { collector, store, calls, advance } = harness((request) => {
      if (request.url.pathname.endsWith('/credentials'))
        return Response.json({
          files: [
            { ...credential(request.provider), name: renamed ? 'renamed.json' : 'original.json' },
            credential(request.provider, 'disabled', true),
            { provider: 'other', type: 'other' },
          ],
        });
      return respond(request);
    });
    await collector.refresh();
    const ids = store.listAccounts().map((account) => account.id);
    expect(store.listAccounts().filter((account) => account.disabled)).toHaveLength(2);
    expect(calls.filter((call) => call.body)).toHaveLength(3);
    renamed = true;
    advance(MANUAL_REFRESH_INTERVAL_MS);
    await collector.refresh();
    expect(store.listAccounts().map((account) => account.id)).toEqual(ids);
    expect(
      store
        .listAccounts()
        .filter((account) => !account.disabled)
        .every((account) => account.name === 'renamed.json')
    ).toBe(true);
  });

  test('single flight shares the promise, manual refresh rate limits and key rotation is reread', async () => {
    const entered = deferred();
    const gate = deferred();
    let blocked = true;
    const { collector, calls, advance, keyFile } = harness(async (request) => {
      if (blocked) {
        entered.release();
        await gate.promise;
      }
      return respond(request);
    });
    const first = collector.refresh();
    expect(collector.refresh()).toBe(first);
    expect(collector.refreshing).toBe(true);
    await entered.promise;
    blocked = false;
    gate.release();
    await first;
    expect(collector.refreshing).toBe(false);
    await collector.refresh();
    advance(MANUAL_REFRESH_INTERVAL_MS - 1);
    await collector.refresh();
    expect(calls).toHaveLength(5);
    writeFileSync(keyFile, 'rotated-synthetic-key\n');
    advance(1);
    await collector.refresh();
    expect(calls).toHaveLength(9);
    expect(new Headers(calls[5].init.headers).get('authorization')).toBe(
      'Bearer rotated-synthetic-key'
    );
  });

  test('failed or incomplete inventories preserve previous accounts and other provider progresses', async () => {
    let bad: unknown = undefined;
    const { collector, store, advance } = harness((request) => {
      if (
        bad !== undefined &&
        request.provider === 'claude' &&
        request.url.pathname.endsWith('/credentials')
      ) {
        return bad === 'http'
          ? new Response('synthetic upstream error', { status: 503 })
          : Response.json(bad);
      }
      return respond(request);
    });
    await collector.refresh();
    const before = store.listAccounts()[0];
    for (const invalid of [
      'http',
      {},
      { files: null },
      { files: [null] },
      { files: [], total: 1, page: 1, has_more: true },
      { files: [], page: 2, total: 0, has_more: false },
      { files: [credential('claude'), { ...credential('claude', 'bad'), disabled: 'false' }] },
      { files: [credential('claude'), credential('claude')] },
      { files: [{ ...credential('claude'), auth_index: 1 }] },
      { files: [{ ...credential('claude'), type: 'codex' }] },
    ]) {
      bad = invalid;
      advance(MANUAL_REFRESH_INTERVAL_MS);
      await collector.refresh();
      expect(store.listAccounts()[0]).toEqual(before);
      expect(collector.issues).toEqual([{ provider: 'claude', code: 'inventory-unavailable' }]);
    }
    bad = { files: [] };
    advance(MANUAL_REFRESH_INTERVAL_MS);
    await collector.refresh();
    expect(store.listAccounts()[0].retired).toBe(true);
    expect(store.listAccounts()[1].retired).toBe(false);
    expect(collector.issues).toEqual([]);
  });

  test('quota partial failures retain history, mark only failed accounts and recover', async () => {
    let failing = false;
    const { collector, store, advance } = harness((request) => {
      if (failing && request.provider === 'claude' && request.body) {
        return Response.json({ status_code: 429, body: 'private upstream error' });
      }
      return respond(request);
    });
    await collector.refresh();
    failing = true;
    advance(MANUAL_REFRESH_INTERVAL_MS);
    await collector.refresh();
    expect(store.listAccounts()[0].lastErrorAtMs).toBe(NOW + MANUAL_REFRESH_INTERVAL_MS);
    expect(store.listAccounts()[1].lastErrorAtMs).toBeNull();
    expect(store.listSamples(NOW, NOW + MANUAL_REFRESH_INTERVAL_MS)).toHaveLength(6);
    expect(collector.issues).toEqual([{ provider: 'claude', code: 'quota-unavailable' }]);
    failing = false;
    advance(MANUAL_REFRESH_INTERVAL_MS);
    await collector.refresh();
    expect(store.listAccounts()[0].lastErrorAtMs).toBeNull();
    expect(collector.issues).toEqual([]);
  });

  test('rejects malformed envelopes, JSON and invalid percentages without fabricating samples', async () => {
    let invalid: unknown;
    const { collector, store, advance } = harness((request) =>
      request.body && request.provider === 'claude' ? Response.json(invalid) : respond(request)
    );
    for (const response of [
      null,
      {},
      { status_code: '200', body: claudeBody },
      { status_code: 200, body: 'invalid JSON' },
      { status_code: 200, body: '[]' },
      { status_code: 200, body: 'true' },
      { status_code: 200, body: {} },
      { status_code: 200, body: { seven_day: 2 } },
      ...[-1, 101, 'NaN', 'Infinity'].map((utilization) => ({
        status_code: 200,
        body: { seven_day: { utilization } },
      })),
    ]) {
      invalid = response;
      await collector.refresh();
      expect(collector.issues).toEqual([{ provider: 'claude', code: 'quota-unavailable' }]);
      expect(
        store
          .listSamples(0, NOW + 100 * MANUAL_REFRESH_INTERVAL_MS)
          .filter((sample) => sample.accountId.startsWith('claude:'))
      ).toEqual([]);
      advance(MANUAL_REFRESH_INTERVAL_MS);
    }
  });

  test('missing general windows stay missing; monthly and scoped windows are excluded', async () => {
    const { collector, store } = harness((request) =>
      request.body
        ? Response.json({
            status_code: 200,
            body:
              request.provider === 'claude'
                ? { seven_day: { utilization: 0 }, seven_day_sonnet: { utilization: 50 } }
                : {
                    rate_limit: {
                      primary_window: { used_percent: 15, limit_window_seconds: 2592000 },
                    },
                    code_review_rate_limit: { primary_window: { used_percent: 1 } },
                  },
          })
        : respond(request)
    );
    await collector.refresh();
    expect(collector.issues).toEqual([]);
    expect(
      store
        .listSamples(NOW, NOW)
        .map((sample) => [sample.accountId.split(':')[0], sample.window, sample.remainingPercent])
    ).toEqual([
      ['claude', 'five-hour', null],
      ['claude', 'weekly', 100],
      ['codex', 'five-hour', null],
      ['codex', 'weekly', null],
    ]);
  });

  test('limits quota concurrency to two across both providers', async () => {
    const occupied = deferred();
    const gate = deferred();
    let active = 0;
    let maximum = 0;
    let quotaCalls = 0;
    const { collector, store } = harness(async (request) => {
      if (!request.body)
        return Response.json({
          files: ['one', 'two', 'three'].map((id) => credential(request.provider, id)),
        });
      active++;
      quotaCalls++;
      maximum = Math.max(maximum, active);
      if (active === 2) occupied.release();
      await gate.promise;
      active--;
      return respond(request);
    });
    const refresh = collector.refresh();
    await occupied.promise;
    expect(quotaCalls).toBe(2);
    gate.release();
    await refresh;
    expect(quotaCalls).toBe(9);
    expect(maximum).toBe(2);
    expect(store.listSamples(NOW, NOW)).toHaveLength(12);
  });

  test('missing key exposes sanitized inventory issues and preserves accounts', async () => {
    const { collector, store, calls, keyFile, advance } = harness();
    await collector.refresh();
    const before = store.listAccounts();
    rmSync(keyFile);
    advance(MANUAL_REFRESH_INTERVAL_MS);
    await collector.refresh();
    expect(store.listAccounts()).toEqual(before);
    expect(calls).toHaveLength(5);
    expect(collector.issues).toEqual([
      { provider: 'claude', code: 'inventory-unavailable' },
      { provider: 'codex', code: 'inventory-unavailable' },
    ]);
  });

  test('start is idempotent and stop aborts active requests without recording errors or samples', async () => {
    const entered = deferred();
    const { collector, store, calls } = harness(async (request) => {
      if (!request.body) return respond(request);
      entered.release();
      await new Promise<void>((_resolve, reject) => {
        request.init.signal?.addEventListener(
          'abort',
          () => reject(new Error('synthetic-private-error')),
          { once: true }
        );
      });
      return respond(request);
    });
    collector.start();
    collector.start();
    const pending = collector.refresh();
    await entered.promise;
    collector.stop();
    await pending;
    expect(collector.refreshing).toBe(false);
    expect(store.listSamples(0, NOW)).toEqual([]);
    expect(store.listAccounts().every((account) => account.lastErrorAtMs === null)).toBe(true);
    expect(calls.filter((call) => !call.body)).toHaveLength(2);
    expect(calls.filter((call) => call.body).every((call) => call.init.signal?.aborted)).toBe(true);
  });
  test('records each account plan; the Claude profile is asked at most every six hours', async () => {
    const { collector, store, calls, advance } = harness((request) => {
      if (request.body?.url === CLAUDE_PROFILE_URL) {
        return Response.json({
          status_code: 200,
          body: JSON.stringify({ organization: { rate_limit_tier: 'default_claude_max_20x' } }),
        });
      }
      if (request.body && request.provider === 'codex') {
        return Response.json({ status_code: 200, body: { ...codexBody, plan_type: 'promax' } });
      }
      return respond(request);
    });
    await collector.refresh();
    const plans = Object.fromEntries(store.listAccounts().map((a) => [a.provider, a.plan]));
    expect(plans).toEqual({ claude: 'default_claude_max_20x', codex: 'promax' });
    const profileCalls = () => calls.filter((c) => c.body?.url === CLAUDE_PROFILE_URL);
    expect(profileCalls()).toHaveLength(1);
    advance(MANUAL_REFRESH_INTERVAL_MS);
    await collector.refresh();
    expect(profileCalls()).toHaveLength(1);
    advance(6 * 60 * 60 * 1000);
    await collector.refresh();
    expect(profileCalls()).toHaveLength(2);
  });
});
