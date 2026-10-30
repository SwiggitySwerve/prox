import type { PoolProviderId, PoolWindow } from '../../src/domain/quotaPool/types';

export interface StoredAccount {
  id: string;
  instanceId?: string;
  provider: PoolProviderId;
  name: string;
  email: string | null;
  disabled: boolean;
  retired: boolean;
  lastSeenAtMs: number;
  lastErrorAtMs: number | null;
  /** Latest plan the provider reported, e.g. "promax" or "default_claude_max_20x". */
  plan?: string;
  planObservedAtMs?: number;
}

export const QUOTA_PROVIDERS: readonly PoolProviderId[] = Object.freeze(['claude', 'codex']);

export interface QuotaSourceView {
  instanceId: string;
  sourceLabel: string;
}

export interface QuotaSample {
  accountId: string;
  window: PoolWindow;
  observedAtMs: number;
  remainingPercent: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

export { HOUR_MS, DAY_MS } from '../../src/utils/time/durations';
export const STALE_MS = 15 * 60_000;
export const MIN_RATE_SPAN_MS = 10 * 60_000;
export const REFRESH_INTERVAL_MS = 5 * 60_000;
// Anthropic's usage endpoint answers bursts with 429; polls under 90 s apart failed 25% of the time.
export const MANUAL_REFRESH_INTERVAL_MS = 4 * 60_000;
