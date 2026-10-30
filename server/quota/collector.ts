import { readJson } from '../http/readJson';
import { readFile } from 'node:fs/promises';
import type { DeploymentSource } from '../../src/domain/providerSources/types';
import { loadSourceManifest } from '../providerSources/config';
import { LEGACY_SOURCE_MAPPING, legacyAccountId } from './identity';
import type { TFunction } from 'i18next';
import type {
  AccountQuotaWindow,
  PoolDashboard,
  PoolProviderId,
  PoolWindow,
} from '../../src/domain/quotaPool/types';
import { buildClaudeQuotaWindows } from '../../src/domain/quotaWindows/claude';
import { buildCodexQuotaWindows } from '../../src/domain/quotaWindows/codex';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_WINDOW_KEYS,
  CLAUDE_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  CODEX_REQUEST_HEADERS,
} from '../../src/utils/quota/constants';
import { parseClaudeUsagePayload, parseCodexUsagePayload } from '../../src/utils/quota/parsers';
import { isRecord } from '../../src/utils/helpers';
import { planFromClaudeProfile, planFromCodexUsage } from './plans';
import { QuotaStore } from './store';
import {
  MANUAL_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  QUOTA_PROVIDERS,
  type QuotaSample,
  type QuotaSourceView,
  type StoredAccount,
} from './types';

const PLAN_REFRESH_MS = 6 * 60 * 60 * 1000;

interface CollectorDependencies {
  fetcher?: typeof fetch;
  now?: () => number;
}
type CollectorOptions = CollectorDependencies &
  (
    | { sources: readonly DeploymentSource[]; revision: string }
    // Compatibility for existing injected tests only. Production always supplies the manifest.
    | { keyFile: string; origins?: Record<PoolProviderId, string>; fetcher: typeof fetch }
  );

interface CollectionSource {
  instanceId?: string;
  label: string;
  upstreamOrigin: string;
  managementKeyFile: string;
  providers: readonly PoolProviderId[];
}

interface InventoryAccount {
  account: StoredAccount;
  authIndex: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Builders require i18next's branded function; labels are not persisted or exposed here.
const label = ((key: string) => key) as TFunction;

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function inventory(payload: unknown, provider: PoolProviderId, nowMs: number): InventoryAccount[] {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.files) ||
    payload.files.length > 10_000 ||
    (payload.has_more !== undefined && payload.has_more !== false) ||
    (payload.total !== undefined && payload.total !== payload.files.length) ||
    (payload.page !== undefined && payload.page !== 1)
  ) {
    throw new Error('Invalid quota inventory');
  }
  const accounts: InventoryAccount[] = [];
  const seen = new Set<string>();
  for (const file of payload.files) {
    if (!isRecord(file)) throw new Error('Invalid quota inventory');
    const kind = file.provider ?? file.type;
    if (
      !boundedString(kind, 64) ||
      (file.provider !== undefined && file.type !== undefined && file.provider !== file.type)
    ) {
      throw new Error('Invalid quota inventory');
    }
    if (kind !== provider) continue;
    if (
      !boundedString(file.auth_index, 256) ||
      !boundedString(file.name, 1024) ||
      typeof file.disabled !== 'boolean' ||
      (file.email !== undefined && file.email !== null && !boundedString(file.email, 1024)) ||
      seen.has(file.auth_index)
    ) {
      throw new Error('Invalid quota inventory');
    }
    seen.add(file.auth_index);
    const id = legacyAccountId(provider, file.auth_index);
    accounts.push({
      authIndex: file.auth_index,
      account: {
        id,
        provider,
        name: file.name,
        email: file.email ?? null,
        disabled: file.disabled,
        retired: false,
        lastSeenAtMs: nowMs,
        lastErrorAtMs: null,
      },
    });
  }
  return accounts;
}

function quotaSamples(
  provider: PoolProviderId,
  accountId: string,
  body: unknown,
  observedAtMs: number
): { samples: QuotaSample[]; windows: AccountQuotaWindow[] } {
  const parsed =
    provider === 'claude'
      ? { provider: 'claude' as const, payload: parseClaudeUsagePayload(body) }
      : { provider: 'codex' as const, payload: parseCodexUsagePayload(body) };
  if (!isRecord(parsed.payload)) throw new Error('Invalid quota response');
  const payload: Record<string, unknown> = parsed.payload;
  // Parsers intentionally accept broad JSON for the UI. Validate its envelope before building.
  const keys =
    provider === 'claude'
      ? [...CLAUDE_USAGE_WINDOW_KEYS.map(({ key }) => key), 'limits']
      : [
          'rate_limit',
          'rateLimit',
          'code_review_rate_limit',
          'codeReviewRateLimit',
          'additional_rate_limits',
          'additionalRateLimits',
        ];
  if (!keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Invalid quota response');
  }
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    const arrayField =
      key === 'limits' || key === 'additional_rate_limits' || key === 'additionalRateLimits';
    if (arrayField ? !Array.isArray(value) : !isRecord(value)) {
      throw new Error('Invalid quota response');
    }
  }
  const windows =
    parsed.provider === 'claude'
      ? buildClaudeQuotaWindows(parsed.payload, label)
      : buildCodexQuotaWindows(parsed.payload, label);
  const samples: QuotaSample[] = [];
  for (const entry of windows) {
    let window: PoolWindow;
    if (entry.id === 'five-hour') window = 'five-hour';
    else if (entry.id === (provider === 'claude' ? 'seven-day' : 'weekly')) window = 'weekly';
    else continue;
    if (
      entry.usedPercent === null ||
      !Number.isFinite(entry.usedPercent) ||
      entry.usedPercent < 0 ||
      entry.usedPercent > 100
    ) {
      throw new Error('Invalid quota response');
    }
    samples.push({
      accountId,
      window,
      observedAtMs,
      remainingPercent: 100 - entry.usedPercent,
      resetAtMs: entry.resetAtMs ?? null,
      periodHours: entry.periodHours ?? null,
    });
  }
  // Explicit missing observations supersede earlier balances without inventing zero usage.
  for (const window of ['weekly', 'five-hour'] as const) {
    if (!samples.some((sample) => sample.window === window)) {
      samples.push({
        accountId,
        window,
        observedAtMs,
        remainingPercent: null,
        resetAtMs: null,
        periodHours: null,
      });
    }
  }
  return {
    samples,
    windows: windows.map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey ?? entry.label,
      ...('labelParams' in entry && entry.labelParams
        ? { labelParams: entry.labelParams as Record<string, string | number> }
        : {}),
      remainingPercent:
        entry.usedPercent !== null && Number.isFinite(entry.usedPercent)
          ? Math.min(100, Math.max(0, 100 - entry.usedPercent))
          : null,
      resetAtMs: entry.resetAtMs ?? null,
    })),
  };
}

/** Enumerates each instance once, then collects supported read-only quota observations. */
export class QuotaCollector {
  private readonly collectionSources: readonly CollectionSource[];
  readonly revision: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAtMs: number | null = null;
  private lastRefresh: number | null = null;
  private nextRefresh: number;
  private currentIssues: PoolDashboard['issues'] = [];
  private readonly profileAttempts = new Map<string, number>();
  private readonly latestWindows = new Map<string, AccountQuotaWindow[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private controller: AbortController | null = null;

  constructor(
    private readonly store: QuotaStore,
    options: CollectorOptions
  ) {
    if ('sources' in options) {
      this.revision = options.revision;
      const seen = new Set<string>();
      this.collectionSources = options.sources.map((source) => {
        if (!source.instanceId || seen.has(source.instanceId))
          throw new Error('Duplicate quota source');
        seen.add(source.instanceId);
        return Object.freeze({ ...source, providers: QUOTA_PROVIDERS });
      });
    } else {
      if (!options.fetcher) throw new Error('Legacy quota injection requires a fetcher');
      const manifest = options.origins
        ? undefined
        : loadSourceManifest(
            new URL('../../deploy/provider-sources.json', import.meta.url).pathname
          ).manifest;
      this.collectionSources = LEGACY_SOURCE_MAPPING.map(({ provider, instanceId }) => {
        const upstreamOrigin =
          options.origins?.[provider] ??
          manifest?.sources.find((source) => source.instanceId === instanceId)?.upstreamOrigin;
        if (!upstreamOrigin) throw new Error('Missing injected quota source');
        return {
          label: provider,
          upstreamOrigin,
          managementKeyFile: options.keyFile,
          providers: [provider],
        };
      });
    }
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.nextRefresh = this.now();
  }

  get refreshing(): boolean {
    return this.inFlight !== null;
  }
  get lastRefreshAtMs(): number | null {
    return this.lastRefresh;
  }
  get nextRefreshAtMs(): number {
    return this.nextRefresh;
  }
  get issues(): PoolDashboard['issues'] {
    // Providers are collected concurrently; report issues in a stable order, not completion order.
    return this.currentIssues
      .map((issue) => ({ ...issue }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  /** In memory only: refilled by the next collection after a restart. */
  get windows(): ReadonlyMap<string, readonly AccountQuotaWindow[]> {
    return this.latestWindows;
  }
  get sources(): QuotaSourceView[] | undefined {
    if (this.revision === undefined) return undefined;
    return this.collectionSources.map((source) => ({
      instanceId: source.instanceId!,
      sourceLabel: source.label,
    }));
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const nowMs = this.now();
    if (
      this.lastAttemptAtMs !== null &&
      nowMs - this.lastAttemptAtMs < MANUAL_REFRESH_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    this.lastAttemptAtMs = nowMs;
    this.nextRefresh = nowMs + REFRESH_INTERVAL_MS;
    this.controller = new AbortController();
    this.inFlight = this.collect(this.controller.signal)
      .catch(() => {
        if (!this.currentIssues.length) {
          for (const source of this.collectionSources) {
            for (const provider of source.providers)
              this.addIssue(source, provider, 'quota-unavailable');
          }
        }
        // Never propagate fetch, filesystem, or SQLite messages containing upstream data.
        throw new Error('Quota refresh failed');
      })
      .finally(() => {
        this.lastRefresh = this.now();
        this.nextRefresh = this.lastRefresh + REFRESH_INTERVAL_MS;
        this.inFlight = null;
        this.controller = null;
        if (this.running) this.schedule();
      });
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Scheduled failures remain visible through issues; manual callers receive the sanitized error.
    void this.refresh().catch(() => {});
    if (!this.inFlight) this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.refresh().catch(() => {});
        if (!this.inFlight && this.running) this.schedule();
      },
      Math.max(0, this.nextRefresh - this.now())
    );
    this.timer.unref?.();
  }

  /** Plan weight is best-effort: a failed lookup leaves the stored plan as it was. */
  private async recordPlan(
    account: { id: string; provider: PoolProviderId },
    authIndex: string,
    source: CollectionSource,
    key: string,
    signal: AbortSignal,
    usageBody: unknown,
    storedPlans: Map<string, number | null>
  ): Promise<void> {
    let plan: string | null = null;
    if (account.provider === 'codex') {
      plan = planFromCodexUsage(usageBody);
    } else {
      // Claude names the plan only in its profile; plans change rarely, so ask every few hours.
      const observedAt = storedPlans.get(account.id) ?? null;
      const attemptedAt = this.profileAttempts.get(account.id) ?? null;
      const last = Math.max(observedAt ?? -Infinity, attemptedAt ?? -Infinity);
      if (this.now() - last < PLAN_REFRESH_MS) return;
      this.profileAttempts.set(account.id, this.now());
      try {
        const response = await this.request(source, 'requests/api-call', key, signal, {
          authIndex,
          method: 'GET',
          url: CLAUDE_PROFILE_URL,
          header: CLAUDE_REQUEST_HEADERS,
        });
        if (isRecord(response) && response.status_code === 200) {
          plan = planFromClaudeProfile(response.body);
        }
      } catch {
        return;
      }
    }
    if (!plan || signal.aborted) return;
    try {
      this.store.recordPlan(account.id, plan, this.now());
    } catch {
      // The plan only weights points; keep the samples and try again next collection.
    }
  }

  private addIssue(
    source: CollectionSource,
    provider: PoolProviderId,
    code: PoolDashboard['issues'][number]['code']
  ): void {
    if (
      !this.currentIssues.some(
        (issue) =>
          issue.instanceId === source.instanceId &&
          issue.provider === provider &&
          issue.code === code
      )
    ) {
      this.currentIssues.push({
        provider,
        code,
        ...(source.instanceId === undefined
          ? {}
          : {
              instanceId: source.instanceId,
              sourceLabel: source.label,
            }),
      });
    }
  }

  private async request(
    source: CollectionSource,
    path: string,
    key: string,
    signal: AbortSignal,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    signal.throwIfAborted();
    const response = await this.fetcher(new URL(`/v8/management/${path}`, source.upstreamOrigin), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Quota request unavailable');
    }
    return readJson(response.body, MAX_RESPONSE_BYTES, 'Quota response too large');
  }

  private async collect(signal: AbortSignal): Promise<void> {
    this.currentIssues = [];
    this.store.prune(this.now());
    const inventories = await Promise.allSettled(
      this.collectionSources.map(async (source) => {
        let key: string;
        let groups: { provider: PoolProviderId; accounts: InventoryAccount[] }[];
        try {
          key = (await readFile(source.managementKeyFile, 'utf8')).trim();
          if (!boundedString(key, 8192)) throw new Error('Invalid management key');
          const payload = await this.request(source, 'credentials', key, signal);
          // Validate every supported kind before retiring any part of this inventory.
          groups = source.providers.map((provider) => ({
            provider,
            accounts: inventory(payload, provider, this.now()),
          }));
        } catch {
          if (!signal.aborted) {
            for (const provider of source.providers)
              this.addIssue(source, provider, 'inventory-unavailable');
          }
          return [];
        }
        if (signal.aborted) return [];
        const pending: (InventoryAccount & { source: CollectionSource; key: string })[] = [];
        for (const { provider, accounts } of groups) {
          try {
            for (const entry of accounts) {
              if (source.instanceId !== undefined) {
                entry.account.instanceId = source.instanceId;
                entry.account.id = this.store.accountIdFor(
                  source.instanceId,
                  provider,
                  entry.authIndex
                );
              }
            }
            this.store.recordInventory(
              provider,
              accounts.map(({ account }) => account),
              this.now(),
              source.instanceId
            );
            pending.push(
              ...accounts
                .filter(({ account }) => !account.disabled)
                .map((entry) => ({ ...entry, source, key }))
            );
          } catch {
            this.addIssue(source, provider, 'inventory-unavailable');
          }
        }
        return pending;
      })
    );
    const accounts: (InventoryAccount & { source: CollectionSource; key: string })[] = [];
    for (const result of inventories) {
      if (result.status === 'rejected') throw new Error('Quota inventory persistence failed');
      accounts.push(...result.value);
    }
    const storedPlans = new Map(
      this.store.listAccounts().map((stored) => [stored.id, stored.planObservedAtMs ?? null])
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < accounts.length && !signal.aborted) {
        const { account, authIndex, source, key } = accounts[cursor++];
        let samples: QuotaSample[];
        let windows: AccountQuotaWindow[];
        let usageBody: unknown;
        let upstreamStatus: unknown;
        try {
          const claude = account.provider === 'claude';
          const response = await this.request(source, 'requests/api-call', key, signal, {
            authIndex,
            method: 'GET',
            url: claude ? CLAUDE_USAGE_URL : CODEX_USAGE_URL,
            header: claude ? CLAUDE_REQUEST_HEADERS : CODEX_REQUEST_HEADERS,
          });
          if (isRecord(response)) upstreamStatus = response.status_code;
          if (
            !isRecord(response) ||
            response.status_code !== 200 ||
            !(typeof response.body === 'string' || isRecord(response.body))
          ) {
            throw new Error('Quota request unavailable');
          }
          ({ samples, windows } = quotaSamples(
            account.provider,
            account.id,
            response.body,
            this.now()
          ));
          usageBody = response.body;
        } catch {
          if (!signal.aborted) {
            // Only the provider and a numeric status: upstream bodies and identities stay out of logs.
            console.error(
              `Quota request failed: ${account.provider} ${typeof upstreamStatus === 'number' ? upstreamStatus : 'no-status'}`
            );
            this.addIssue(source, account.provider, 'quota-unavailable');
            this.store.markAccountError(account.id, this.now());
          }
          continue;
        }
        if (!signal.aborted) {
          try {
            this.store.recordSamples(samples);
            this.latestWindows.set(account.id, windows);
          } catch {
            this.addIssue(source, account.provider, 'quota-unavailable');
            throw new Error('Quota sample persistence failed');
          }
          await this.recordPlan(account, authIndex, source, key, signal, usageBody, storedPlans);
        }
      }
    };
    const workers = await Promise.allSettled([worker(), worker()]);
    if (workers.some((result) => result.status === 'rejected')) {
      throw new Error('Quota sample persistence failed');
    }
  }
}
