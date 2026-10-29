export interface ChartDatum {
  key: string;
  label: string;
  value: number | null;
  at?: number;
}
/** Bars never join samples: missing measurements and missing time buckets remain gaps. */
export function barGeometry(data: ChartDatum[], from?: number, to?: number, interval?: number) {
  const maximum = Math.max(1, ...data.map((d) => d.value ?? 0));
  const timed = from !== undefined && to !== undefined && to > from && interval !== undefined;
  return data.map((datum, index) => {
    const left = timed ? Math.max(from, datum.at ?? from) : index;
    const right = timed ? Math.min(to, (datum.at ?? from) + interval) : index + 1;
    const span = timed ? to - from : Math.max(1, data.length);
    const x = 24 + ((left - (timed ? from : 0)) / span) * 552;
    const width = Math.max(1, ((right - left) / span) * 552 - 3);
    const height = datum.value === null ? null : Math.max(0, datum.value / maximum) * 112;
    return { ...datum, x, width, height };
  });
}
