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
export function fitChartFrame(width: number, compact = false, minimized = false) {
  const height = minimized ? 160 : compact ? 220 : width < 600 ? 240 : 280;
  return {
    width,
    height,
    left: width < 600 ? 40 : 52,
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
  const min = Math.min(0, ...values);
  const max = Math.max(mode === 'remaining' ? capacity : 0, ...values);
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
