import { expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaCollector } from '../../server/quota/collector';
import { QuotaStore } from '../../server/quota/store';
import type { DeploymentSource } from '../../src/domain/providerSources/types';
import type { PoolProviderId } from '../../src/domain/quotaPool/types';
export const NOW = 1_800_000_000_000;
export const RESET = NOW + 86_400_000;
const codexUsage = {
  rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: RESET / 1000 },
    secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: RESET / 1000 },
  },
};
export const ORIGINS = {
  'codex-primary': 'http://codex.test',
  'claude-primary': 'http://claude.test',
};
export type InstanceId = keyof typeof ORIGINS;

interface FakeFile {
  provider: PoolProviderId;
  type: PoolProviderId;
  auth_index: string;
  name: string;
  email: string;
  disabled: boolean;
}
export const file = (provider: PoolProviderId, digest: string, disabled = false): FakeFile => ({
  provider,
  type: provider,
  auth_index: digest,
  name: `${digest}.json`,
  email: 'shared@example.test',
  disabled,
});
export function deferred<T = void>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(2);
  expect(condition()).toBe(true);
}

const cleanups: (() => void)[] = [];
/** Call from each test file's afterEach: hooks registered here would only reach the first importer. */
export function cleanupHarnesses() {
  for (const cleanup of cleanups.splice(0)) cleanup();
}

/** A fake CLI-Proxy per source plus the real store and collector. */
export function harness() {
  const root = mkdtempSync(join(tmpdir(), 'prox-sync-'));
  const keyFile = join(root, 'management-key');
  writeFileSync(keyFile, 'synthetic-management-key\n', { mode: 0o600 });
  let clock = NOW;
  const store = new QuotaStore(join(root, 'data', 'quota.sqlite'), () => clock);
  const lists: Record<InstanceId, unknown[]> = { 'codex-primary': [], 'claude-primary': [] };
  /** Replaces the credentials response of a source: a status code or a raw payload. */
  const override: Partial<Record<InstanceId, number | unknown>> = {};
  const calls: { instanceId: InstanceId; path: string; body: Record<string, unknown> | null }[] =
    [];
  const signals: { authIndex: string; signal: AbortSignal }[] = [];
  /** Hold a request open: return a promise from the hook to delay its response. */
  const hooks = {
    credentials: undefined as
      undefined | ((instanceId: InstanceId, n: number) => Promise<void> | void),
    usage: undefined as
      undefined | ((authIndex: string, signal: AbortSignal) => Promise<void> | void),
  };
  const credentialReads: Record<InstanceId, number> = { 'codex-primary': 0, 'claude-primary': 0 };
  const sleeps: number[] = [];
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const instanceId = (Object.entries(ORIGINS).find(([, origin]) => origin === url.origin) ?? [
        '',
      ])[0] as InstanceId;
      const path = url.pathname.replace('/v8/management', '');
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ instanceId, path, body });
      if (path === '/credentials') {
        const n = ++credentialReads[instanceId];
        // The response is fixed when the request arrives, as a real server's would be; a hook
        // only delays its delivery. That is what makes a held read stale.
        const replaced = override[instanceId];
        const payload = { files: [...lists[instanceId]] };
        await hooks.credentials?.(instanceId, n);
        if (typeof replaced === 'number') return new Response('unavailable', { status: replaced });
        if (replaced !== undefined) return Response.json(replaced);
        return Response.json(payload);
      }
      const authIndex = String(body?.authIndex);
      signals.push({ authIndex, signal: init!.signal! });
      await hooks.usage?.(authIndex, init!.signal!);
      return Response.json({ status_code: 200, body: codexUsage });
    },
    { preconnect: () => {} }
  ) satisfies typeof fetch;
  const sources: DeploymentSource[] = (Object.keys(ORIGINS) as InstanceId[]).map((instanceId) => ({
    instanceId,
    label: instanceId,
    publicBasePath: `/${instanceId}`,
    aliases: [],
    authScope: 'test',
    upstreamOrigin: ORIGINS[instanceId],
    managementKeyFile: keyFile,
  }));
  const collector = new QuotaCollector(store, {
    sources,
    revision: 'test',
    fetcher,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  cleanups.push(() => {
    collector.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const idOf = (digest: string, instanceId: InstanceId = 'codex-primary') =>
    store.accountIdFor(instanceId, instanceId === 'codex-primary' ? 'codex' : 'claude', digest);
  const row = (id: string) => store.listAccounts().find((account) => account.id === id);
  const usageCalls = () => calls.filter((call) => call.path !== '/credentials');
  return {
    store,
    collector,
    lists,
    override,
    calls,
    signals,
    hooks,
    sleeps,
    credentialReads,
    idOf,
    row,
    usageCalls,
    keyFile,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
