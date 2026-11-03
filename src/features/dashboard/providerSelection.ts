import type { SourceView } from '@/services/providerSources/registry';
import type { Config } from '@/types';
import type { RecentRequestBucket } from '@/utils/recentRequests';
import type { CredentialHealth, DashboardCounts, ProviderTraffic, TrafficWindow } from './types';
import { providerLabel } from './utils';

/** The provider hues the app already uses (Quota, Analytics); others stay neutral. */
export const providerColor = (brand: string | null): string =>
  brand === 'claude'
    ? 'var(--claude-color)'
    : brand === 'codex'
      ? 'var(--codex-color)'
      : 'var(--text-tertiary)';

/** "All providers", or one connected source's instance id. */
export type ProviderSelection = 'all' | string;
export const ALL_PROVIDERS = 'all';

/** Marks the app already ships; other providers show the name without a logo. */
const BRANDS = new Set(['claude', 'codex']);

export interface ProviderPill {
  /** Source instance id */
  id: string;
  /** The source's own label, e.g. "GPT / Codex" */
  label: string;
  /** Provider name(s) the source serves, or the source label when it declares none */
  name: string;
  /** Logo and colour key, when the source serves exactly one known provider */
  brand: string | null;
}

/**
 * One pill per connected source, in manifest order. A source the session cannot read
 * (another auth scope, or unauthorized) is not connected, so it gets no pill.
 */
export function connectedProviderPills(
  sources: readonly SourceView[],
  unknownLabel: string
): ProviderPill[] {
  return sources
    .filter((view) => view.status === 'ready' && view.session !== null)
    .map(({ source }) => {
      const providers = source.providers ?? [];
      const single = providers.length === 1 ? providers[0] : null;
      return {
        id: source.instanceId,
        label: source.label,
        name: providers.length
          ? providers.map((id) => providerLabel(id, unknownLabel)).join(' + ')
          : source.label,
        brand: single && BRANDS.has(single) ? single : null,
      };
    });
}

/** A selection survives only while its source is still connected. */
export function effectiveSelection(
  selection: ProviderSelection,
  pills: readonly ProviderPill[]
): ProviderSelection {
  return pills.some((pill) => pill.id === selection) ? selection : ALL_PROVIDERS;
}

/** What one source's dashboard hook reported. */
export interface SourceOverview {
  version: string | null;
  buildDate: string | null;
  config: Config | null;
  counts: DashboardCounts;
  traffic: TrafficWindow;
  trafficSource: 'analytics' | 'recent';
  providers: ProviderTraffic[];
  credentials: CredentialHealth | null;
}

export type DashboardSource = ProviderPill & SourceOverview;

export interface TrafficSeries {
  id: string;
  name: string;
  brand: string | null;
  /** Aligned to the combined buckets: same length, latest bucket last */
  buckets: RecentRequestBucket[];
  total: number;
}

export interface FleetRow extends ProviderTraffic {
  key: string;
  sourceId: string;
  trafficSource: 'analytics' | 'recent';
}

export interface DashboardView {
  sources: DashboardSource[];
  traffic: TrafficWindow;
  /** Per-source stacks for the chart; null when one source is shown */
  series: TrafficSeries[] | null;
  /** The sources bucket traffic differently, so their columns cannot share one axis */
  mixedWindows: boolean;
  trafficSource: 'analytics' | 'recent' | 'mixed';
  fleet: FleetRow[];
  credentials: CredentialHealth | null;
  counts: DashboardCounts;
}

const EMPTY_TRAFFIC: TrafficWindow = {
  buckets: [],
  totalSuccess: 0,
  totalFailure: 0,
  total: 0,
  successRate: null,
  peakTotal: 0,
  peakIndex: -1,
  windowMinutes: 0,
  bucketMinutes: 10,
};

const byVolume = (a: ProviderTraffic, b: ProviderTraffic) =>
  b.total - a.total || b.credentials - a.credentials || a.id.localeCompare(b.id);

/** Null only when no source knows the number. */
const sumKnown = (values: Array<number | null>): number | null =>
  values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;

/** Latest bucket last in every source, so the windows line up from the right. */
const alignRight = (buckets: RecentRequestBucket[], length: number): RecentRequestBucket[] => [
  ...Array.from({ length: length - buckets.length }, () => ({ success: 0, failed: 0 })),
  ...buckets.slice(-length),
];

function combineTraffic(sources: DashboardSource[]) {
  const totalSuccess = sources.reduce((sum, source) => sum + source.traffic.totalSuccess, 0);
  const totalFailure = sources.reduce((sum, source) => sum + source.traffic.totalFailure, 0);
  const total = totalSuccess + totalFailure;
  const withBuckets = sources.filter((source) => source.traffic.buckets.length > 0);
  const mixedWindows = new Set(withBuckets.map((source) => source.traffic.bucketMinutes)).size > 1;
  const length = mixedWindows
    ? 0
    : Math.max(0, ...withBuckets.map((source) => source.traffic.buckets.length));
  // Time labels come from the longest window, which covers every other one.
  const labels = withBuckets.find((source) => source.traffic.buckets.length === length);
  const series: TrafficSeries[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    brand: source.brand,
    buckets: alignRight(source.traffic.buckets, length),
    total: source.traffic.total,
  }));
  const buckets = Array.from({ length }, (_, index) => ({
    time: labels?.traffic.buckets[index]?.time,
    success: series.reduce((sum, entry) => sum + entry.buckets[index].success, 0),
    failed: series.reduce((sum, entry) => sum + entry.buckets[index].failed, 0),
  }));
  const totals = buckets.map((bucket) => bucket.success + bucket.failed);
  const peakTotal = Math.max(0, ...totals);
  const traffic: TrafficWindow = {
    buckets,
    totalSuccess,
    totalFailure,
    total,
    successRate: total > 0 ? (totalSuccess / total) * 100 : null,
    peakTotal,
    peakIndex: peakTotal > 0 ? totals.indexOf(peakTotal) : -1,
    windowMinutes: mixedWindows
      ? 0
      : Math.max(0, ...withBuckets.map((source) => source.traffic.windowMinutes)),
    bucketMinutes: labels?.traffic.bucketMinutes ?? sources[0]?.traffic.bucketMinutes ?? 10,
  };
  return { traffic, series, mixedWindows };
}

function combineCredentials(sources: DashboardSource[]): CredentialHealth | null {
  const known = sources
    .map((source) => source.credentials)
    .filter((entry): entry is CredentialHealth => entry !== null);
  if (known.length === 0) return null;
  const byType = new Map<string, number>();
  known.forEach((entry) =>
    entry.byType.forEach(({ type, count }) => byType.set(type, (byType.get(type) ?? 0) + count))
  );
  return {
    total: known.reduce((sum, entry) => sum + entry.total, 0),
    active: known.reduce((sum, entry) => sum + entry.active, 0),
    disabled: known.reduce((sum, entry) => sum + entry.disabled, 0),
    unavailable: known.reduce((sum, entry) => sum + entry.unavailable, 0),
    byType: Array.from(byType, ([type, count]) => ({ type, count })).sort(
      (a, b) => b.count - a.count || a.type.localeCompare(b.type)
    ),
  };
}

/**
 * The dashboard for the selected sources. One source passes through unchanged; several are
 * added together, keeping each source's share of the traffic for the stacked chart.
 */
export function buildDashboardView(sources: DashboardSource[]): DashboardView {
  const fleet = sources
    .flatMap((source) =>
      source.providers.map((row) => ({
        ...row,
        key: `${source.id}:${row.id}`,
        sourceId: source.id,
        trafficSource: source.trafficSource,
      }))
    )
    .sort(byVolume);
  const trafficSources = new Set(sources.map((source) => source.trafficSource));
  const trafficSource = trafficSources.size > 1 ? 'mixed' : (sources[0]?.trafficSource ?? 'recent');
  const counts: DashboardCounts = {
    managementKeys: sumKnown(sources.map((source) => source.counts.managementKeys)),
    providerKeys: sumKnown(sources.map((source) => source.counts.providerKeys)),
    credentials: sumKnown(sources.map((source) => source.counts.credentials)),
    models: sumKnown(sources.map((source) => source.counts.models)),
  };

  if (sources.length <= 1) {
    return {
      sources,
      traffic: sources[0]?.traffic ?? EMPTY_TRAFFIC,
      series: null,
      mixedWindows: false,
      trafficSource,
      fleet,
      credentials: sources[0]?.credentials ?? null,
      counts,
    };
  }
  const { traffic, series, mixedWindows } = combineTraffic(sources);
  return {
    sources,
    traffic,
    series,
    mixedWindows,
    trafficSource,
    fleet,
    credentials: combineCredentials(sources),
    counts,
  };
}
