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
export function fitChartFrame(width: number) {
  const height = width < 600 ? 240 : 300;
  return {
    width,
    height,
    left: width < 600 ? 40 : 52,
    right: width - 12,
    top: 38,
    bottom: height - 38,
  };
}

export function chartSamples(recorded: PoolPoint[], projected: PoolPoint[], mode: ChartMode) {
  return [
    ...recorded.map((point) => ({ point, projected: false })),
    ...(mode === 'remaining' ? projected.map((point) => ({ point, projected: true })) : []),
  ];
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
  const segments = (projected: boolean) => {
    const paths: string[] = [];
    let path = '';
    for (const sample of samples.filter((item) => item.projected === projected)) {
      const value = sample.point[metricField[mode]];
      if (value === null) {
        if (path) paths.push(path);
        path = '';
      } else {
        path += `${path ? ' L' : 'M'}${x(sample.point.atMs)},${y(value)}`;
      }
    }
    if (path) paths.push(path);
    return paths;
  };
  return { x, y, min, max, segments };
}
