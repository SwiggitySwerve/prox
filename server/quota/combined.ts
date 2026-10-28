import type { CombinedPoolResult, PoolPoint, QuotaPool } from '../../src/domain/quotaPool/types';
import { sumKnown } from './values';

/** A forecast is piecewise linear; duplicate timestamps preserve the two sides of a reset. */
function projectedBalance(points: PoolPoint[], atMs: number, beforeReset: boolean): number | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].atMs < atMs) lo = mid + 1;
    else hi = mid;
  }
  if (points[lo]?.atMs === atMs) {
    if (beforeReset) return points[lo].remainingPoints;
    while (points[lo + 1]?.atMs === atMs) lo++;
    return points[lo].remainingPoints;
  }
  const left = points[lo - 1];
  const right = points[lo];
  if (!left || !right || left.remainingPoints === null || right.remainingPoints === null)
    return null;
  return (
    left.remainingPoints +
    (right.remainingPoints - left.remainingPoints) * ((atMs - left.atMs) / (right.atMs - left.atMs))
  );
}

/** Add independent provider forecasts; never reroute demand between providers. */
export function alignProjections(traces: PoolPoint[][]): PoolPoint[][] {
  if (!traces.length || traces.some((trace) => !trace.length)) return [];
  const times = [...new Set(traces.flatMap((trace) => trace.map((point) => point.atMs)))].sort(
    (a, b) => a - b
  );
  const resets = new Set(
    traces.flatMap((trace) =>
      trace.flatMap((point, index) =>
        index > 0 && trace[index - 1].atMs === point.atMs ? [point.atMs] : []
      )
    )
  );
  const events = times.flatMap((atMs) =>
    (resets.has(atMs) ? [true, false] : [false]).map((beforeReset) => ({ atMs, beforeReset }))
  );
  return traces.map((trace) =>
    events.map(({ atMs, beforeReset }) => ({
      atMs,
      remainingPoints: projectedBalance(trace, atMs, beforeReset),
      burnPointsPerHour: null,
      drainPointsPerHour: null,
    }))
  );
}

export function combineProjections(traces: PoolPoint[][]): PoolPoint[] {
  const aligned = alignProjections(traces);
  return (aligned[0] ?? []).map((point, index) => ({
    ...point,
    remainingPoints: sumKnown(aligned.map((trace) => trace[index].remainingPoints)),
  }));
}

/** Only distinct provider allowances are proven independent by the current source contract. */
export function combinedPools(pools: QuotaPool[], recorded: () => PoolPoint[]): CombinedPoolResult {
  const eligible = pools.filter(
    (pool) => pool.eligibleCount > 0 || pool.forecastState !== 'no-accounts'
  );
  if (!eligible.length) return { series: null, unavailableReason: 'no-accounts' };
  if (new Set(eligible.map((pool) => pool.provider)).size !== eligible.length)
    return { series: null, unavailableReason: 'ambiguous-sources' };
  const forecastState = eligible.some((pool) => pool.forecastState === 'stale')
    ? 'stale'
    : eligible.some((pool) => pool.forecastState === 'partial')
      ? 'partial'
      : eligible.some((pool) => pool.forecastState !== 'ready')
        ? 'collecting'
        : 'ready';
  const projected =
    forecastState === 'ready' ? combineProjections(eligible.map((pool) => pool.projected)) : [];
  const resets = new Map<number, number[]>();
  if (forecastState === 'ready')
    for (const pool of eligible)
      for (const reset of pool.resets) {
        resets.set(reset.atMs, [...(resets.get(reset.atMs) ?? []), reset.gainPoints]);
      }
  return {
    unavailableReason: null,
    series: {
      capacityPoints: sumKnown(eligible.map((pool) => pool.capacityPoints))!,
      remainingPoints: sumKnown(eligible.map((pool) => pool.remainingPoints)),
      burnPointsPerHour: sumKnown(eligible.map((pool) => pool.burnPointsPerHour)),
      drainPointsPerHour: sumKnown(eligible.map((pool) => pool.drainPointsPerHour)),
      forecastState,
      // A failed inventory with no known members is unknown, never a zero-sized pool.
      recorded: eligible.some((pool) => pool.eligibleCount === 0) ? [] : recorded(),
      projected,
      resets: [...resets]
        .sort(([a], [b]) => a - b)
        .map(([atMs, gains]) => ({ atMs, gainPoints: sumKnown(gains)! })),
      poolEmptyAtMs: projected.find((point) => point.remainingPoints === 0)?.atMs ?? null,
    },
  };
}
