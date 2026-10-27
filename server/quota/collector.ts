import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TFunction } from 'i18next';
import type { PoolDashboard, PoolProviderId, PoolWindow } from '../../src/domain/quotaPool/types';
import { buildClaudeQuotaWindows } from '../../src/domain/quotaWindows/claude';
import { buildCodexQuotaWindows } from '../../src/domain/quotaWindows/codex';
import {
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_WINDOW_KEYS,
  CLAUDE_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  CODEX_REQUEST_HEADERS,
} from '../../src/utils/quota/constants';
import { parseClaudeUsagePayload, parseCodexUsagePayload } from '../../src/utils/quota/parsers';
import { isRecord } from '../../src/utils/helpers';
import { QuotaStore } from './store';
import {
  MANUAL_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  type QuotaSample,
  type StoredAccount,
} from './types';

interface CollectorOptions {
  keyFile: string;
  origins?: Record<PoolProviderId, string>;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface InventoryAccount {
  account: StoredAccount;
  authIndex: string;
}

const PROVIDERS: PoolProviderId[] = ['claude', 'codex'];
const DEFAULT_ORIGINS: Record<PoolProviderId, string> = {
  claude: 'http://127.0.0.1:8319',
  codex: 'http://127.0.0.1:8317',
};
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
    const id = `${provider}:${createHash('sha256')
      .update(`${provider}\0${file.auth_index}`)
      .digest('hex')}`;
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
): QuotaSample[] {
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
  return samples;
}

/** Collects read-only quota observations from the two management services. */
export class QuotaCollector {
  private readonly origins: Record<PoolProviderId, string>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAtMs: number | null = null;
  private lastRefresh: number | null = null;
  private nextRefresh: number;
  private currentIssues: PoolDashboard['issues'] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private controller: AbortController | null = null;

  constructor(
    private readonly store: QuotaStore,
    private readonly options: CollectorOptions
  ) {
    this.origins = options.origins ?? DEFAULT_ORIGINS;
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
    return this.currentIssues.map((issue) => ({ ...issue }));
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
        this.currentIssues = PROVIDERS.map((provider) => ({ provider, code: 'quota-unavailable' }));
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

  private addIssue(provider: PoolProviderId, code: PoolDashboard['issues'][number]['code']): void {
    if (!this.currentIssues.some((issue) => issue.provider === provider && issue.code === code)) {
      this.currentIssues.push({ provider, code });
    }
  }

  private async request(
    provider: PoolProviderId,
    path: string,
    key: string,
    signal: AbortSignal,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    signal.throwIfAborted();
    const response = await this.fetcher(new URL(`/v8/management/${path}`, this.origins[provider]), {
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
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Quota response too large');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  private async collect(signal: AbortSignal): Promise<void> {
    this.currentIssues = [];
    this.store.prune(this.now());
    let key: string;
    try {
      key = (await readFile(this.options.keyFile, 'utf8')).trim();
      if (!boundedString(key, 8192)) throw new Error('Invalid management key');
    } catch {
      this.currentIssues = PROVIDERS.map((provider) => ({
        provider,
        code: 'inventory-unavailable',
      }));
      return;
    }
    const inventories = await Promise.allSettled(
      PROVIDERS.map(async (provider) => {
        let accounts: InventoryAccount[];
        try {
          accounts = inventory(
            await this.request(provider, 'credentials', key, signal),
            provider,
            this.now()
          );
        } catch {
          if (!signal.aborted) this.addIssue(provider, 'inventory-unavailable');
          return [];
        }
        if (signal.aborted) return [];
        this.store.recordInventory(
          provider,
          accounts.map(({ account }) => account),
          this.now()
        );
        return accounts.filter(({ account }) => !account.disabled);
      })
    );
    const accounts: InventoryAccount[] = [];
    for (const result of inventories) {
      if (result.status === 'rejected') throw new Error('Quota inventory persistence failed');
      accounts.push(...result.value);
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < accounts.length && !signal.aborted) {
        const { account, authIndex } = accounts[cursor++];
        let samples: QuotaSample[];
        try {
          const claude = account.provider === 'claude';
          const response = await this.request(account.provider, 'requests/api-call', key, signal, {
            authIndex,
            method: 'GET',
            url: claude ? CLAUDE_USAGE_URL : CODEX_USAGE_URL,
            header: claude ? CLAUDE_REQUEST_HEADERS : CODEX_REQUEST_HEADERS,
          });
          if (
            !isRecord(response) ||
            response.status_code !== 200 ||
            !(typeof response.body === 'string' || isRecord(response.body))
          ) {
            throw new Error('Quota request unavailable');
          }
          samples = quotaSamples(account.provider, account.id, response.body, this.now());
        } catch {
          if (!signal.aborted) {
            this.store.markAccountError(account.id, this.now());
            this.addIssue(account.provider, 'quota-unavailable');
          }
          continue;
        }
        if (!signal.aborted) this.store.recordSamples(samples);
      }
    };
    const workers = await Promise.allSettled([worker(), worker()]);
    if (workers.some((result) => result.status === 'rejected')) {
      throw new Error('Quota sample persistence failed');
    }
  }
}
