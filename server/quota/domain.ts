import type {
  PoolAccount,
  PoolDashboard,
  PoolPoint,
  PoolProviderId,
  PoolReset,
  PoolWindow,
  QuotaPool,
} from '../../src/domain/quotaPool/types';
import { DAY_MS, HOUR_MS, MIN_RATE_SPAN_MS, REFRESH_INTERVAL_MS, STALE_MS } from './types';
import {
  QUOTA_PROVIDERS,
  type QuotaSample,
  type QuotaSourceView,
  type StoredAccount,
} from './types';

export interface DashboardOptions {
  nowMs: number;
  window: PoolWindow;
  lookbackHours: 1 | 3 | 6;
  multiplier: 0 | 0.5 | 1 | 2;
  offsetDays: number;
  reveal: boolean;
}
export interface CollectionState {
  historyStartedAtMs: number | null;
  lastRefreshAtMs: number | null;
  nextRefreshAtMs: number;
  refreshing: boolean;
  issues: PoolDashboard['issues'];
  sources?: readonly QuotaSourceView[];
}
type Rates = { burn: number | null; drain: number | null };

function latestIndex(samples: QuotaSample[], atMs: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].observedAtMs <= atMs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Only measured intervals count. Gaps and resets never become fabricated consumption. */
export function measuredRates(samples: QuotaSample[], atMs: number, hours: number): Rates {
  const end = latestIndex(samples, atMs);
  if (
    end < 1 ||
    samples[end].remainingPercent === null ||
    atMs - samples[end].observedAtMs > STALE_MS
  )
    return { burn: null, drain: null };
  let burn = 0;
  let burnSpan = 0;
  let net = 0;
  let netSpan = 0;
  const since = atMs - hours * HOUR_MS;
  for (let i = end; i > 0; i--) {
    const current = samples[i];
    const previous = samples[i - 1];
    if (previous.observedAtMs < since) break;
    if (current.remainingPercent === null || previous.remainingPercent === null) continue;
    const elapsed = current.observedAtMs - previous.observedAtMs;
    if (elapsed <= 0 || elapsed > STALE_MS) continue;
    const delta = previous.remainingPercent - current.remainingPercent;
    net += delta;
    netSpan += elapsed;
    // Absolute reset times may differ slightly when derived from seconds remaining.
    const sameCycle =
      previous.resetAtMs !== null &&
      current.resetAtMs !== null &&
      Math.abs(previous.resetAtMs - current.resetAtMs) <= 60_000 &&
      previous.resetAtMs > current.observedAtMs;
    if (sameCycle && delta >= 0) {
      burn += delta;
      burnSpan += elapsed;
    }
  }
  return {
    burn: burnSpan >= MIN_RATE_SPAN_MS ? (burn * HOUR_MS) / burnSpan : null,
    drain: netSpan >= MIN_RATE_SPAN_MS ? (net * HOUR_MS) / netSpan : null,
  };
}

function currentSample(
  samples: QuotaSample[],
  atMs: number
): (QuotaSample & { remainingPercent: number }) | undefined {
  const sample = samples[latestIndex(samples, atMs)];
  if (!sample || sample.remainingPercent === null || atMs - sample.observedAtMs > STALE_MS) return;
  if (sample.resetAtMs !== null && sample.resetAtMs <= atMs) return;
  return { ...sample, remainingPercent: sample.remainingPercent };
}

function sumKnown(values: (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

interface ForecastInput {
  remaining: number;
  rate: number;
  resetAtMs: number;
  periodHours: number;
}
export function projectPool(inputs: ForecastInput[], nowMs: number, toMs: number) {
  const accounts = inputs.map((input) => ({ ...input }));
  const points: PoolPoint[] = [];
  const resets: PoolReset[] = [];
  let firstEmptyAtMs: number | null = null;
  let poolEmptyAtMs: number | null = null;
  let time = nowMs;
  const record = () => {
    const remaining = accounts.reduce((sum, a) => sum + a.remaining, 0);
    points.push({
      atMs: time,
      remainingPoints: remaining,
      burnPointsPerHour: null,
      drainPointsPerHour: null,
    });
    if (accounts.some((a) => a.remaining <= 1e-8) && firstEmptyAtMs === null) firstEmptyAtMs = time;
    if (remaining <= 1e-8 && poolEmptyAtMs === null) poolEmptyAtMs = time;
  };
  if (!accounts.length) return { points, resets, firstEmptyAtMs, poolEmptyAtMs };
  record();
  while (time < toMs) {
    const nextReset = Math.min(...accounts.map((a) => a.resetAtMs));
    const emptyTimes = accounts.map((a) =>
      a.rate > 0 && a.remaining > 1e-8 ? time + (a.remaining / a.rate) * HOUR_MS : Infinity
    );
    const nextEmpty = Math.min(...emptyTimes);
    const next = Math.min(time + HOUR_MS / 2, nextReset, nextEmpty, toMs);
    if (next < time || (next === time && nextEmpty !== time))
      throw new Error('Invalid forecast cycle');
    for (const [index, account] of accounts.entries()) {
      // Epoch timestamps lose sub-millisecond precision. The depletion event owns
      // the zero balance; subtracting elapsed time can leave a tiny residual.
      account.remaining =
        emptyTimes[index] <= next
          ? 0
          : Math.max(0, account.remaining - (account.rate * (next - time)) / HOUR_MS);
    }
    time = next;
    record();
    let gain = 0;
    for (const account of accounts) {
      if (account.resetAtMs <= time) {
        gain += 100 - account.remaining;
        account.remaining = 100;
        account.resetAtMs += account.periodHours * HOUR_MS;
      }
    }
    if (nextReset <= time) {
      resets.push({ atMs: time, gainPoints: gain });
      record();
    }
  }
  return { points, resets, firstEmptyAtMs, poolEmptyAtMs };
}

function buildPool(
  provider: PoolProviderId,
  source: StoredAccount[],
  samples: QuotaSample[],
  options: DashboardOptions,
  fromMs: number,
  toMs: number,
  inventoryFailed: boolean
): QuotaPool {
  const { nowMs, lookbackHours, multiplier } = options;
  const accounts = source
    .filter((a) => a.provider === provider && !a.retired)
    .sort((a, b) => a.id.localeCompare(b.id));
  const active = accounts.filter((a) => !a.disabled);
  const histories = new Map<string, QuotaSample[]>();
  for (const a of accounts) histories.set(a.id, []);
  for (const sample of samples) histories.get(sample.accountId)?.push(sample);
  for (const history of histories.values()) history.sort((a, b) => a.observedAtMs - b.observedAtMs);
  const forecastInputs: ForecastInput[] = [];
  const accountViews: PoolAccount[] = accounts.map((account, index) => {
    const history = histories.get(account.id)!;
    const latest = history[latestIndex(history, nowMs)];
    const sample = currentSample(history, nowMs);
    const status: PoolAccount['status'] = account.disabled
      ? 'disabled'
      : account.lastErrorAtMs !== null && (!latest || account.lastErrorAtMs >= latest.observedAtMs)
        ? 'error'
        : nowMs - account.lastSeenAtMs > STALE_MS ||
            (latest && nowMs - latest.observedAtMs > STALE_MS)
          ? 'stale'
          : latest?.remainingPercent === null
            ? 'missing-window'
            : latest && !sample
              ? 'stale'
              : !sample
                ? 'missing-window'
                : 'ok';
    const rates =
      status === 'ok' ? measuredRates(history, nowMs, lookbackHours) : { burn: null, drain: null };
    if (
      status === 'ok' &&
      sample?.resetAtMs &&
      sample.periodHours &&
      sample.periodHours > 0 &&
      rates.burn !== null
    ) {
      forecastInputs.push({
        remaining: sample.remainingPercent,
        rate: rates.burn * multiplier,
        resetAtMs: sample.resetAtMs,
        periodHours: sample.periodHours,
      });
    }
    const emptyAt =
      sample && rates.burn !== null && rates.burn * multiplier > 0
        ? nowMs + (sample.remainingPercent / (rates.burn * multiplier)) * HOUR_MS
        : null;
    return {
      id: account.id,
      label: `${provider === 'claude' ? 'Claude' : 'Codex'} ${index + 1}`,
      ...(options.reveal ? { email: account.email || account.name } : {}),
      disabled: account.disabled,
      status,
      observedAtMs: latest?.observedAtMs ?? null,
      remainingPercent: latest?.remainingPercent ?? null,
      resetAtMs: latest?.resetAtMs ?? null,
      burnPointsPerHour: rates.burn,
      emptyAtMs:
        status !== 'ok'
          ? null
          : sample?.remainingPercent === 0
            ? nowMs
            : emptyAt !== null && sample?.resetAtMs && emptyAt <= sample.resetAtMs
              ? emptyAt
              : null,
    };
  });
  const eligible = accountViews.filter((a) => !a.disabled);
  const loaded = eligible.filter((a) => a.status === 'ok');
  const complete = loaded.length === eligible.length && !inventoryFailed;
  const rates = active.map((a) => measuredRates(histories.get(a.id)!, nowMs, lookbackHours));
  const forecastState: QuotaPool['forecastState'] = !eligible.length
    ? inventoryFailed
      ? 'partial'
      : 'no-accounts'
    : !complete
      ? eligible.some((a) => a.status === 'stale')
        ? 'stale'
        : 'partial'
      : forecastInputs.length !== active.length
        ? 'collecting'
        : 'ready';
  const projection =
    forecastState === 'ready'
      ? projectPool(forecastInputs, nowMs, Math.max(toMs, nowMs + 14 * DAY_MS))
      : { points: [], resets: [], firstEmptyAtMs: null, poolEmptyAtMs: null };
  const bucketTimes = new Map<number, number>();
  for (const sample of samples) {
    if (
      !active.some((a) => a.id === sample.accountId) ||
      sample.observedAtMs < fromMs ||
      sample.observedAtMs > Math.min(nowMs, toMs)
    )
      continue;
    const bucket = Math.floor(sample.observedAtMs / REFRESH_INTERVAL_MS);
    bucketTimes.set(bucket, Math.max(bucketTimes.get(bucket) ?? 0, sample.observedAtMs));
  }
  const recorded = [...bucketTimes.values()]
    .sort((a, b) => a - b)
    .map((time): PoolPoint => {
      const snapshots = active.map((a) => currentSample(histories.get(a.id)!, time));
      const historicalRates = active.map((a) =>
        measuredRates(histories.get(a.id)!, time, lookbackHours)
      );
      return {
        atMs: time,
        remainingPoints: sumKnown(snapshots.map((s) => s?.remainingPercent ?? null)),
        burnPointsPerHour: sumKnown(historicalRates.map((r) => r.burn)),
        drainPointsPerHour: sumKnown(historicalRates.map((r) => r.drain)),
      };
    });
  // Break lines across unobserved collection gaps; SVG must not connect them.
  for (let i = recorded.length - 1; i > 0; i--) {
    if (recorded[i].atMs - recorded[i - 1].atMs > STALE_MS) {
      recorded.splice(i, 0, {
        atMs: recorded[i - 1].atMs + STALE_MS,
        remainingPoints: null,
        burnPointsPerHour: null,
        drainPointsPerHour: null,
      });
    }
  }
  const nextResetAtMs = loaded.reduce<number | null>(
    (earliest, a) =>
      a.resetAtMs !== null && a.resetAtMs > nowMs
        ? Math.min(earliest ?? Infinity, a.resetAtMs)
        : earliest,
    null
  );
  return {
    provider,
    accountCount: accounts.length,
    eligibleCount: eligible.length,
    loadedCount: loaded.length,
    capacityPoints: eligible.length * 100,
    remainingPoints: complete ? sumKnown(eligible.map((a) => a.remainingPercent)) : null,
    burnPointsPerHour: complete ? sumKnown(rates.map((r) => r.burn)) : null,
    drainPointsPerHour: complete ? sumKnown(rates.map((r) => r.drain)) : null,
    forecastState,
    firstEmptyAtMs: projection.firstEmptyAtMs,
    poolEmptyAtMs: projection.poolEmptyAtMs,
    nextResetAtMs,
    nextResetGainPoints: projection.resets[0]?.gainPoints ?? null,
    recorded,
    projected: projection.points.filter((p) => p.atMs >= fromMs && p.atMs <= toMs),
    resets: projection.resets.filter((p) => p.atMs >= fromMs && p.atMs <= toMs),
    accounts: accountViews,
  };
}

export function buildDashboard(
  accounts: StoredAccount[],
  samples: QuotaSample[],
  options: DashboardOptions,
  collection: CollectionState
): PoolDashboard {
  const fromMs = Math.floor(options.nowMs / DAY_MS) * DAY_MS + (options.offsetDays - 3) * DAY_MS;
  const toMs = fromMs + 14 * DAY_MS;
  const filtered = samples.filter((s) => s.window === options.window);
  const { sources, ...state } = collection;
  const scopes = new Map<string, QuotaSourceView>();
  for (const source of sources ?? []) scopes.set(source.instanceId, source);
  for (const entry of [...accounts, ...collection.issues]) {
    if (entry.instanceId !== undefined && !scopes.has(entry.instanceId)) {
      scopes.set(entry.instanceId, {
        instanceId: entry.instanceId,
        sourceLabel: ('sourceLabel' in entry ? entry.sourceLabel : undefined) ?? entry.instanceId,
      });
    }
  }
  const scoped = sources !== undefined || scopes.size > 0;
  const allPools = (scoped ? [...scopes.values()] : [undefined]).flatMap((source) =>
    QUOTA_PROVIDERS.map((provider) => ({
      ...buildPool(
        provider,
        accounts.filter((account) => account.instanceId === source?.instanceId),
        filtered,
        options,
        fromMs,
        toMs,
        (sources !== undefined &&
          !sources.some((entry) => entry.instanceId === source?.instanceId)) ||
          collection.issues.some(
            (issue) =>
              issue.instanceId === source?.instanceId &&
              issue.provider === provider &&
              issue.code === 'inventory-unavailable'
          )
      ),
      ...source,
    }))
  );
  // A source containing one supported provider does not create an empty sibling-provider card.
  // Retain empty results when the entire source is empty, and preserve failure visibility.
  const pools = allPools.filter(
    (pool) =>
      !scoped ||
      pool.accountCount > 0 ||
      !allPools.some((other) => other.instanceId === pool.instanceId && other.accountCount > 0) ||
      collection.issues.some(
        (issue) => issue.instanceId === pool.instanceId && issue.provider === pool.provider
      )
  );
  return {
    nowMs: options.nowMs,
    fromMs,
    toMs,
    window: options.window,
    lookbackHours: options.lookbackHours,
    multiplier: options.multiplier,
    ...state,
    pools,
    ...(scoped
      ? {
          unresolvedHistoryAccountCount: accounts.filter(
            (account) => account.instanceId === undefined
          ).length,
          combinations: QUOTA_PROVIDERS.flatMap((provider) => {
            const local = pools.filter(
              (pool) =>
                pool.provider === provider &&
                (pool.accountCount > 0 ||
                  collection.issues.some(
                    (issue) => issue.instanceId === pool.instanceId && issue.provider === provider
                  ))
            );
            return local.length < 2
              ? []
              : [
                  {
                    provider,
                    reason: 'cross-source-combination-unverified' as const,
                    occurrenceCount: local.reduce((count, pool) => count + pool.accountCount, 0),
                    capacityPoints: null,
                    remainingPoints: null,
                    burnPointsPerHour: null,
                    drainPointsPerHour: null,
                    firstEmptyAtMs: null,
                    poolEmptyAtMs: null,
                    recorded: [] as [],
                    projected: [] as [],
                  },
                ];
          }),
        }
      : {}),
  };
}
