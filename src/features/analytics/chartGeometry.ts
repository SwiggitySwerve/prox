export interface ChartDatum {
  key: string;
  label: string;
  value: number | null;
  at?: number;
}
export interface LinePoint {
  at: number;
  value: number | null;
}
/**
 * Polyline segments for one timeline series scaled to its own maximum. A null value or a
 * missing bucket ends the segment, so the line never bridges an unmeasured period.
 */
export function lineSegments(
  points: LinePoint[],
  frame: {
    from: number;
    to: number;
    interval: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  },
  shared?: number
) {
  const maximum = shared ?? Math.max(0, ...points.map((p) => p.value ?? 0));
  const span = Math.max(1, frame.to - frame.from);
  // A bucket sits at the middle of its part inside the range, so partial edge buckets stay on the plot.
  const x = (at: number) => {
    const start = Math.max(frame.from, at);
    const end = Math.min(frame.to, at + frame.interval);
    const mid = end > start ? (start + end) / 2 : Math.min(Math.max(at, frame.from), frame.to);
    return frame.left + ((mid - frame.from) / span) * (frame.right - frame.left);
  };
  const y = (value: number) =>
    frame.bottom - (maximum > 0 ? value / maximum : 0) * (frame.bottom - frame.top);
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let previous: number | null = null;
  for (const point of [...points].sort((a, b) => a.at - b.at)) {
    const gap = previous !== null && point.at - previous > frame.interval * 1.5;
    if (point.value === null || gap) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (point.value !== null) current.push([x(point.at), y(point.value)]);
    previous = point.at;
  }
  if (current.length) segments.push(current);
  return { maximum, segments, x, y };
}

/** Axis maximum on a 1-2-2.5-5 step, so quarter ticks land on round values. */
export function niceMaximum(value: number) {
  if (!(value > 0)) return 0;
  const raw = value / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw - 1e-9)!;
  return step * 4;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Evenly spaced UTC tick times on whole hours or days, at most `maxTicks` of them. */
export function timeTicks(from: number, to: number, interval: number, maxTicks: number) {
  const steps = [1, 2, 3, 4, 6, 12]
    .map((h) => h * HOUR)
    .concat([1, 2, 5, 7, 14].map((d) => d * DAY));
  const step =
    steps.find((s) => s >= interval && (to - from) / s <= maxTicks) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  for (let at = Math.ceil(from / step) * step; at <= to; at += step) ticks.push(at);
  return ticks;
}
