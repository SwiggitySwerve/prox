import { expect, test } from 'bun:test';
import { LatencyGroups, nearestRank } from '../server/usage/latency';

test('CPAMP nearestRank equals a full sort on deterministic random, duplicate and ordered data', () => {
  let seed = 321;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  expect(nearestRank(new Float64Array())).toBeNull();
  for (let n = 1; n <= 1000; n++) {
    const values = Array.from({ length: n }, () => Math.floor(random() * (n % 3 ? 100000 : 5)) + 1);
    const sorted = [...values].sort((a, b) => a - b);
    const want = sorted[Math.floor((n * 95 + 99) / 100) - 1];
    for (const input of [values, sorted, [...sorted].reverse()])
      expect(nearestRank(Float64Array.from(input))).toBe(want);
  }
});
test('latency groups ignore absent/nonpositive samples independently at every dimension', () => {
  const samples = new LatencyGroups();
  for (let n = 1; n <= 100; n++) samples.add(n % 2, n % 3, n % 4, n, n * 2);
  samples.add(1000, 1000, 1000, 0, null);
  samples.add(1000, 1000, 1000, null, -10);
  const result = samples.result();
  expect(result.overall).toEqual({ p95_latency_ms: 95, p95_ttft_ms: 190 });
  for (const [map, divisor] of [
    [result.buckets, 2],
    [result.models, 3],
    [result.providers, 4],
  ] as const) {
    for (let key = 0; key < divisor; key++) {
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1).filter(
        (n) => n % divisor === key
      );
      const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
      expect(map.get(key)).toEqual({ p95_latency_ms: value, p95_ttft_ms: value * 2 });
    }
    expect(map.get(1000)).toEqual({ p95_latency_ms: null, p95_ttft_ms: null });
  }
});
