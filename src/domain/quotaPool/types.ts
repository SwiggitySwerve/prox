/** Public contract for the server-owned quota history and forecast domain. */
export type PoolProviderId = 'claude' | 'codex';
export type PoolWindow = 'weekly' | 'five-hour';
export type PoolForecastState = 'ready' | 'collecting' | 'partial' | 'stale' | 'no-accounts';
export interface PoolPoint {
  atMs: number;
  remainingPoints: number | null;
  burnPointsPerHour: number | null;
  drainPointsPerHour: number | null;
}
export interface PoolReset {
  atMs: number;
  gainPoints: number;
}
export interface PoolAccount {
  id: string;
  label: string;
  email?: string;
  disabled: boolean;
  status: 'ok' | 'stale' | 'error' | 'disabled' | 'missing-window';
  observedAtMs: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
  burnPointsPerHour: number | null;
  emptyAtMs: number | null;
}
export interface QuotaPool {
  provider: PoolProviderId;
  accountCount: number;
  eligibleCount: number;
  loadedCount: number;
  capacityPoints: number;
  remainingPoints: number | null;
  burnPointsPerHour: number | null;
  drainPointsPerHour: number | null;
  forecastState: PoolForecastState;
  firstEmptyAtMs: number | null;
  poolEmptyAtMs: number | null;
  nextResetAtMs: number | null;
  nextResetGainPoints: number | null;
  recorded: PoolPoint[];
  projected: PoolPoint[];
  resets: PoolReset[];
  accounts: PoolAccount[];
}
export interface PoolDashboard {
  nowMs: number;
  fromMs: number;
  toMs: number;
  window: PoolWindow;
  lookbackHours: 1 | 3 | 6;
  multiplier: 0 | 0.5 | 1 | 2;
  historyStartedAtMs: number | null;
  lastRefreshAtMs: number | null;
  nextRefreshAtMs: number;
  refreshing: boolean;
  issues: { provider: PoolProviderId; code: 'inventory-unavailable' | 'quota-unavailable' }[];
  pools: QuotaPool[];
}
