// Exact positive-sample nearest rank, with in-place selection instead of a full sort.
export function nearestRank(samples: Float64Array): number | null {
  if (!samples.length) return null;
  const k = Math.floor((samples.length * 95 + 99) / 100) - 1;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const pivot = samples[(lo + hi) >>> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (samples[i] < pivot) i++;
      while (samples[j] > pivot) j--;
      if (i <= j) {
        const value = samples[i];
        samples[i++] = samples[j];
        samples[j--] = value;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return samples[k];
  }
  return samples[k];
}
class Samples {
  private values = new Float64Array(32);
  private length = 0;
  add(value: number | null) {
    if (value === null || value <= 0) return;
    if (this.length === this.values.length) {
      const expanded = new Float64Array(this.length * 2);
      expanded.set(this.values);
      this.values = expanded;
    }
    this.values[this.length++] = value;
  }
  addSamples(samples: Int32Array) {
    const needed = this.length + samples.length;
    if (needed > this.values.length) {
      const expanded = new Float64Array(Math.max(needed, this.values.length * 2));
      expanded.set(this.values.subarray(0, this.length));
      this.values = expanded;
    }
    // Most rollup groups contain only a handful of events. Avoid crossing the typed-array
    // bulk-copy boundary eight times per tiny row; keep bulk copies for larger groups.
    if (samples.length <= 16) {
      for (let i = 0; i < samples.length; i++) this.values[this.length + i] = samples[i];
    } else this.values.set(samples, this.length);
    this.length = needed;
  }
  p95() {
    return nearestRank(this.values.subarray(0, this.length));
  }
}
class Pair {
  latency = new Samples();
  ttft = new Samples();
  add(latency: number | null, ttft: number | null) {
    this.latency.add(latency);
    this.ttft.add(ttft);
  }
  addSamples(latency: Int32Array, ttft: Int32Array) {
    this.latency.addSamples(latency);
    this.ttft.addSamples(ttft);
  }
  result() {
    return { p95_latency_ms: this.latency.p95(), p95_ttft_ms: this.ttft.p95() };
  }
}
export class LatencyGroups {
  private overall = new Pair();
  private buckets = new Map<number, Pair>();
  private models = new Map<number, Pair>();
  private providers = new Map<number, Pair>();
  add(
    bucket: number,
    model: number,
    provider: number,
    latency: number | null,
    ttft: number | null
  ) {
    this.overall.add(latency, ttft);
    this.group(this.buckets, bucket).add(latency, ttft);
    this.group(this.models, model).add(latency, ttft);
    this.group(this.providers, provider).add(latency, ttft);
  }
  addSamples(
    bucket: number,
    model: number,
    provider: number,
    latency: Int32Array,
    ttft: Int32Array
  ) {
    this.overall.addSamples(latency, ttft);
    this.group(this.buckets, bucket).addSamples(latency, ttft);
    this.group(this.models, model).addSamples(latency, ttft);
    this.group(this.providers, provider).addSamples(latency, ttft);
  }
  private group(map: Map<number, Pair>, key: number): Pair {
    let group = map.get(key);
    if (!group) {
      group = new Pair();
      map.set(key, group);
    }
    return group;
  }
  result() {
    const results = (map: Map<number, Pair>) =>
      new Map([...map].map(([key, pair]) => [key, pair.result()]));
    return {
      overall: this.overall.result(),
      buckets: results(this.buckets),
      models: results(this.models),
      providers: results(this.providers),
    };
  }
}
