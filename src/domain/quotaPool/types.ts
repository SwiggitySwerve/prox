/** Public contract for the server-owned quota history and forecast domain. */
export type PoolProviderId = 'claude' | 'codex';
export type PoolWindow = 'weekly' | 'five-hour';
export type PoolForecastState =
  | 'ready'
  | 'collecting'
  | 'partial'
  | 'stale'
  | 'no-accounts'
  /** Every eligible account answered and has no limit in this window, so there is nothing to total. */
  | 'no-limit';
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
  /** Masked address or name, always present, so accounts can be told apart. */
  identifier?: string;
  /** Claude Ultra answered with other limits but no five-hour one: that limit does not exist for it. */
  noFiveHourLimit?: boolean;
  email?: string;
  disabled: boolean;
  /** `no-limit`: the provider answered and the account has no limit in this window (Ultra, 5-hour). */
  status: 'ok' | 'stale' | 'error' | 'disabled' | 'missing-window' | 'no-limit';
  observedAtMs: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
  burnPointsPerHour: number | null;
  emptyAtMs: number | null;
  /** Subscription weight; capacityPoints is 100 per base plan (Claude Pro / ChatGPT Plus). */
  plan: { label: string | null; capacityPoints: number; known: boolean };
  /** Latest reading of every limit the provider reports (5-hour, weekly, per-model weekly…). */
  windows: AccountQuotaWindow[];
}
export interface AccountQuotaWindow {
  id: string;
  labelKey: string;
  labelParams?: Record<string, string | number>;
  remainingPercent: number | null;
  resetAtMs: number | null;
}
export interface QuotaPool {
  instanceId?: string;
  sourceLabel?: string;
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
/** Shared trace contract; combined totals have no provider identity or credential inventory. */
export type PoolTrace = Pick<
  QuotaPool,
  | 'capacityPoints'
  | 'remainingPoints'
  | 'burnPointsPerHour'
  | 'drainPointsPerHour'
  | 'forecastState'
  | 'recorded'
  | 'projected'
  | 'resets'
  | 'poolEmptyAtMs'
>;
export type PoolLayer = PoolTrace & Pick<QuotaPool, 'provider' | 'instanceId' | 'sourceLabel'>;
export interface CombinedPoolResult {
  /** Provider contributions on the same history/event timeline; contains no account metadata. */
  layers?: PoolLayer[];
  series: PoolTrace | null;
  unavailableReason: 'no-accounts' | 'ambiguous-sources' | null;
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
  issues: {
    instanceId?: string;
    sourceLabel?: string;
    provider: PoolProviderId;
    code: 'inventory-unavailable' | 'quota-unavailable';
  }[];
  /** Occurrences across sources are never interpreted as independent allowances. */
  combinations?: {
    provider: PoolProviderId;
    reason: 'cross-source-combination-unverified';
    occurrenceCount: number;
    capacityPoints: null;
    remainingPoints: null;
    burnPointsPerHour: null;
    drainPointsPerHour: null;
    firstEmptyAtMs: null;
    poolEmptyAtMs: null;
    recorded: [];
    projected: [];
  }[];
  unresolvedHistoryAccountCount?: number;
  pools: QuotaPool[];
  /** Optional during a UI/history-service rolling upgrade. */
  combined?: Record<PoolProviderId | 'all', CombinedPoolResult>;
}
