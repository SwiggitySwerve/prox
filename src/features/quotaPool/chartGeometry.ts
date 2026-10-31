import type { PoolPoint } from '@/domain/quotaPool/types';

export type ChartMode = 'remaining' | 'drain' | 'burn';
export const metricField = {
  remaining: 'remainingPoints',
  drain: 'drainPointsPerHour',
  burn: 'burnPointsPerHour',
} as const;

export interface ChartSample {
  point: PoolPoint;
  projected: boolean;
}

export const chartFrame = { width: 1000, height: 300, left: 64, right: 976, top: 38, bottom: 254 };

/** Keep labels in CSS pixels instead of shrinking a desktop SVG on phones. */
export function fitChartFrame(
  width: number,
  compact = false,
  minimized = false,
  /** Characters in the widest axis label, so five-digit totals are not cut off. */
  labelChars = 0
) {
  const height = minimized ? 160 : compact ? 220 : width < 600 ? 240 : 280;
  return {
    width,
    height,
    left: Math.max(width < 600 ? 40 : 52, Math.ceil(labelChars * 8.4) + 16),
    right: width - 12,
    top: 38,
    bottom: height - 38,
  };
}

/** Midnights in the viewer's timezone, `step` days apart, so each date label sits on its own day. */
export function dayTicks(fromMs: number, toMs: number, maxTicks: number): number[] {
  const day = new Date(fromMs);
  day.setHours(0, 0, 0, 0);
  if (day.getTime() < fromMs) day.setDate(day.getDate() + 1);
  const days = Math.round((toMs - day.getTime()) / 86_400_000);
  const step = Math.max(1, Math.ceil(days / Math.max(1, maxTicks - 1)));
  const ticks: number[] = [];
  for (; day.getTime() <= toMs; day.setDate(day.getDate() + step)) ticks.push(day.getTime());
  return ticks;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The span a chart shows. A 5-hour window cycles within hours, so it shows a day either side of
 * the snapshot; rates have no forecast, so their range ends just after the snapshot.
 */
export function viewRange(
  view: { fromMs: number; toMs: number; nowMs: number; window: 'weekly' | 'five-hour' },
  mode: ChartMode
) {
  // Browsing an earlier range keeps its own end as the reference point.
  const anchor = Math.min(Math.max(view.nowMs, view.fromMs), view.toMs);
  let { fromMs, toMs } = view;
  if (view.window === 'five-hour') {
    fromMs = Math.max(fromMs, anchor - DAY_MS);
    toMs = Math.min(toMs, anchor + DAY_MS);
  }
  if (mode !== 'remaining') {
    toMs = Math.min(toMs, Math.max(anchor + HOUR_MS, anchor + (anchor - fromMs) * 0.05));
  }
  return { fromMs, toMs };
}

/**
 * Samples inside the range, plus the nearest one beyond each edge when the line crosses it, so a
 * clipped chart draws the line up to its edge instead of stopping at the last sample inside.
 */
export function inRange<T extends ChartSample>(samples: T[], fromMs: number, toMs: number): T[] {
  const kept: T[] = [];
  for (const projected of [false, true]) {
    const run = samples.filter((sample) => sample.projected === projected);
    const at = (sample: T) => sample.point.atMs;
    const first = run.findIndex((sample) => at(sample) >= fromMs);
    let last = run.length - 1;
    while (last >= 0 && at(run[last]) > toMs) last -= 1;
    if (first === -1 || last === -1 || first > last + 1) continue;
    kept.push(...run.slice(Math.max(0, first - 1), Math.min(run.length, last + 2)));
  }
  return kept;
}

/** Whole local hours, a fixed step apart, for ranges too short for one tick per day. */
export function hourTicks(fromMs: number, toMs: number, maxTicks: number): number[] {
  const step =
    [1, 2, 3, 4, 6, 8, 12, 24].find((hours) => (toMs - fromMs) / (hours * HOUR_MS) < maxTicks) ??
    24;
  const at = new Date(fromMs);
  at.setMinutes(0, 0, 0);
  if (at.getTime() < fromMs) at.setHours(at.getHours() + 1);
  while (at.getHours() % step) at.setHours(at.getHours() + 1);
  const ticks: number[] = [];
  for (; at.getTime() <= toMs; at.setHours(at.getHours() + step)) ticks.push(at.getTime());
  return ticks;
}

export function chartSamples(recorded: PoolPoint[], projected: PoolPoint[], mode: ChartMode) {
  return [
    ...recorded.map((point) => ({ point, projected: false })),
    ...(mode === 'remaining' ? projected.map((point) => ({ point, projected: true })) : []),
  ];
}

/** Split visible runs once so line and area paths break at the same missing observations. */
function knownRuns<T>(items: readonly T[], known: (item: T) => boolean): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];
  for (const item of items) {
    if (known(item)) run.push(item);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

export interface StackSample extends ChartSample {
  lower: number | null;
  upper: number | null;
}

/** Display offsets only. The server supplies aligned provider values and their total. */
export function stackSamples(
  layers: ChartSample[][],
  total: ChartSample[],
  mode: ChartMode
): StackSample[][] {
  const field = metricField[mode];
  const output: StackSample[][] = layers.map(() => []);
  total.forEach((reference, index) => {
    const aligned = layers.map((layer) => layer[index]);
    const known =
      reference.point[field] !== null &&
      aligned.every(
        (sample) =>
          sample?.point.atMs === reference.point.atMs &&
          sample.projected === reference.projected &&
          sample.point[field] !== null
      );
    let positive = 0;
    let negative = 0;
    aligned.forEach((sample, layer) => {
      const value = sample?.point[field] ?? null;
      let lower: number | null = null;
      let upper: number | null = null;
      if (known && value !== null) {
        lower = value >= 0 ? positive : negative;
        upper = lower + value;
        if (value >= 0) positive = upper;
        else negative = upper;
      }
      output[layer].push({ ...(sample ?? reference), lower, upper });
    });
  });
  return output;
}

export function bandSegments(
  samples: StackSample[],
  projected: boolean,
  x: (at: number) => number,
  y: (value: number) => number
): string[] {
  return knownRuns(
    samples.filter((sample) => sample.projected === projected),
    (sample) => sample.lower !== null && sample.upper !== null
  ).map((run) => {
    const top = run.map((sample) => `${x(sample.point.atMs)},${y(sample.upper!)}`);
    const bottom = [...run]
      .reverse()
      .map((sample) => `${x(sample.point.atMs)},${y(sample.lower!)}`);
    return `M${top.join(' L')} L${bottom.join(' L')} Z`;
  });
}

/** The next value from 1, 2, 3, 4, 5, 6 or 8 times a power of ten, so the axis midpoint is round too. */
function roundUp(value: number) {
  if (value <= 0) return 0;
  const scale = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 3, 4, 5, 6, 8, 10].find((step) => step * scale >= value - 1e-9) ?? 10) * scale;
}

/** SVG coordinates only. Never infer quota or fill absent observations. */
export function chartGeometry(
  samples: ChartSample[],
  mode: ChartMode,
  capacity: number,
  from: number,
  to: number,
  frame = chartFrame
) {
  const values = samples.flatMap(({ point }) => {
    const value = point[metricField[mode]];
    return value === null ? [] : [value];
  });
  // Remaining is anchored to capacity; rates have no anchor, so round their ends for clean ticks.
  const round = (value: number) => (mode === 'remaining' ? value : roundUp(value));
  const min = 0 - round(-Math.min(0, ...values)); // 0 - 0 is +0, so the axis never reads "-0"
  const max = round(Math.max(mode === 'remaining' ? capacity : 0, ...values));
  const span = max - min || 1;
  const x = (at: number) =>
    frame.left + ((at - from) / (to - from || 1)) * (frame.right - frame.left);
  const y = (value: number) => frame.bottom - ((value - min) / span) * (frame.bottom - frame.top);
  const segments = (projected: boolean, series: ChartSample[] = samples) => {
    return knownRuns(
      series.filter((item) => item.projected === projected),
      (sample) => sample.point[metricField[mode]] !== null
    ).map((run) =>
      run
        .map(
          (sample, index) =>
            `${index ? ' L' : 'M'}${x(sample.point.atMs)},${y(sample.point[metricField[mode]]!)}`
        )
        .join('')
    );
  };
  return { x, y, min, max, segments };
}
