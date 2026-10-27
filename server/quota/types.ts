import type { PoolProviderId, PoolWindow } from '../../src/domain/quotaPool/types';

export interface StoredAccount {
  id: string;
  provider: PoolProviderId;
  name: string;
  email: string | null;
  disabled: boolean;
  retired: boolean;
  lastSeenAtMs: number;
  lastErrorAtMs: number | null;
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
export const MANUAL_REFRESH_INTERVAL_MS = 60_000;
