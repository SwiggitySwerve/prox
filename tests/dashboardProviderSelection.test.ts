import { describe, expect, test } from 'bun:test';
import type { SourceView } from '../src/services/providerSources/registry';
import type { SourceSession } from '../src/services/api/sourceSession';
import {
  ALL_PROVIDERS,
  buildDashboardView,
  connectedProviderPills,
  effectiveSelection,
  providerColor,
  type DashboardSource,
} from '../src/features/dashboard/providerSelection';
import type { TrafficWindow } from '../src/features/dashboard/types';

const session = {} as SourceSession;

const view = (
  instanceId: string,
  label: string,
  providers: string[] | undefined,
  status: SourceView['status'] = 'ready'
): SourceView => ({
  source: {
    instanceId,
    label,
    publicBasePath: `/${instanceId}`,
    aliases: [],
    authScope: 'scope',
    apiBase: `https://prox.test/${instanceId}`,
    ...(providers ? { providers } : {}),
  },
  session: status === 'ready' ? session : null,
  status,
  version: null,
  supportsPlugin: false,
});

const window = (
  buckets: Array<[success: number, failed: number]>,
  bucketMinutes = 10
): TrafficWindow => {
  const totalSuccess = buckets.reduce((sum, [success]) => sum + success, 0);
  const totalFailure = buckets.reduce((sum, [, failed]) => sum + failed, 0);
  const total = totalSuccess + totalFailure;
  return {
    buckets: buckets.map(([success, failed], index) => ({ time: `t${index}`, success, failed })),
    totalSuccess,
    totalFailure,
    total,
    successRate: total > 0 ? (totalSuccess / total) * 100 : null,
    peakTotal: Math.max(0, ...buckets.map(([s, f]) => s + f)),
    peakIndex: 0,
    windowMinutes: buckets.length * bucketMinutes,
    bucketMinutes,
  };
};

const source = (
  id: string,
  brand: string,
  traffic: TrafficWindow,
  overrides: Partial<DashboardSource> = {}
): DashboardSource => ({
  id,
  label: `${brand} source`,
  name: brand === 'codex' ? 'Codex' : 'Claude',
  brand,
  version: '1.0.0',
  buildDate: null,
  config: null,
  counts: { managementKeys: 1, providerKeys: null, credentials: 2, models: null },
  traffic,
  trafficSource: 'recent',
  providers: [
    {
      id: brand,
      credentials: 2,
      success: traffic.totalSuccess,
      failure: traffic.totalFailure,
      total: traffic.total,
      successRate: traffic.successRate,
      buckets: traffic.buckets,
    },
  ],
  credentials: {
    total: 2,
    active: 1,
    disabled: brand === 'codex' ? 1 : 0,
    unavailable: brand === 'claude' ? 1 : 0,
    byType: [{ type: brand, count: 2 }],
  },
  ...overrides,
});

describe('connectedProviderPills', () => {
  test('one pill per connected source, in manifest order, named by its providers', () => {
    const pills = connectedProviderPills(
      [
        view('codex-primary', 'GPT / Codex', ['codex']),
        view('claude-primary', 'Claude / Claude Code', ['claude']),
      ],
      'Unattributed'
    );
    expect(pills).toEqual([
      { id: 'codex-primary', label: 'GPT / Codex', name: 'Codex', brand: 'codex' },
      { id: 'claude-primary', label: 'Claude / Claude Code', name: 'Claude', brand: 'claude' },
    ]);
  });

  test('sources this session cannot read get no pill', () => {
    const pills = connectedProviderPills(
      [
        view('codex-primary', 'GPT / Codex', ['codex']),
        view('claude-primary', 'Claude', ['claude'], 'authentication-required'),
        view('claude-backup', 'Claude backup', ['claude'], 'unauthorized'),
      ],
      'Unattributed'
    );
    expect(pills.map((pill) => pill.id)).toEqual(['codex-primary']);
  });

  test('a source without declared providers keeps its label and no brand', () => {
    const [external, mixed] = connectedProviderPills(
      [view('external', 'proxy.example:8317', undefined), view('m', 'Mixed', ['gemini', 'xai'])],
      'Unattributed'
    );
    expect(external).toMatchObject({ name: 'proxy.example:8317', brand: null });
    expect(mixed).toMatchObject({ name: 'Gemini + xAI', brand: null });
  });

  test('no connected sources means no pills', () => {
    expect(connectedProviderPills([], 'Unattributed')).toEqual([]);
  });
});

describe('effectiveSelection', () => {
  const pills = connectedProviderPills([view('codex-primary', 'Codex', ['codex'])], 'x');
  test('keeps a connected selection and falls back to all when its source goes away', () => {
    expect(effectiveSelection('codex-primary', pills)).toBe('codex-primary');
    expect(effectiveSelection('claude-primary', pills)).toBe(ALL_PROVIDERS);
    expect(effectiveSelection(ALL_PROVIDERS, pills)).toBe(ALL_PROVIDERS);
  });
});

describe('buildDashboardView', () => {
  const codex = source(
    'codex-primary',
    'codex',
    window([
      [5, 1],
      [10, 0],
      [20, 2],
    ])
  );
  const claude = source(
    'claude-primary',
    'claude',
    window([
      [3, 0],
      [4, 1],
    ]),
    {
      counts: { managementKeys: 2, providerKeys: null, credentials: 2, models: null },
    }
  );

  test('a single provider passes through untouched, without per-provider stacks', () => {
    const result = buildDashboardView([codex]);
    expect(result.traffic).toBe(codex.traffic);
    expect(result.series).toBeNull();
    expect(result.credentials).toBe(codex.credentials);
    expect(result.fleet.map((row) => row.key)).toEqual(['codex-primary:codex']);
  });

  test('all providers add up, keeping each provider’s share per bucket', () => {
    const result = buildDashboardView([codex, claude]);
    expect(result.traffic.totalSuccess).toBe(35 + 7);
    expect(result.traffic.totalFailure).toBe(3 + 1);
    expect(result.traffic.total).toBe(46);
    expect(result.traffic.successRate).toBeCloseTo((42 / 46) * 100);
    // Claude's shorter window lines up with the latest buckets.
    expect(result.series?.map((entry) => entry.buckets.map((b) => b.success + b.failed))).toEqual([
      [6, 10, 22],
      [0, 3, 5],
    ]);
    expect(result.traffic.buckets.map((b) => [b.success, b.failed])).toEqual([
      [5, 1],
      [13, 0],
      [24, 3],
    ]);
    expect(result.traffic.buckets.map((b) => b.time)).toEqual(['t0', 't1', 't2']);
    expect(result.traffic.peakTotal).toBe(27);
    expect(result.traffic.peakIndex).toBe(2);
    expect(result.series?.map((entry) => [entry.name, entry.total])).toEqual([
      ['Codex', 38],
      ['Claude', 8],
    ]);
  });

  test('all providers keep every fleet row, credential and count', () => {
    const result = buildDashboardView([claude, codex]);
    expect(result.fleet.map((row) => row.key)).toEqual([
      'codex-primary:codex',
      'claude-primary:claude',
    ]);
    expect(result.credentials).toEqual({
      total: 4,
      active: 2,
      disabled: 1,
      unavailable: 1,
      byType: [
        { type: 'claude', count: 2 },
        { type: 'codex', count: 2 },
      ],
    });
    // Unknown everywhere stays unknown; known values add up.
    expect(result.counts).toEqual({
      managementKeys: 3,
      providerKeys: null,
      credentials: 4,
      models: null,
    });
  });

  test('windows of different bucket sizes are not drawn on one axis', () => {
    const hourly = source('claude-primary', 'claude', window([[30, 2]], 60), {
      trafficSource: 'analytics',
    });
    const result = buildDashboardView([codex, hourly]);
    expect(result.mixedWindows).toBe(true);
    expect(result.traffic.buckets).toEqual([]);
    expect(result.traffic.total).toBe(38 + 32);
    expect(result.trafficSource).toBe('mixed');
  });

  test('nothing reported yet is an empty dashboard, not a crash', () => {
    const result = buildDashboardView([]);
    expect(result.traffic.total).toBe(0);
    expect(result.traffic.successRate).toBeNull();
    expect(result.credentials).toBeNull();
    expect(result.fleet).toEqual([]);
  });
});

test('providerColor uses the app’s Claude and Codex hues', () => {
  expect(providerColor('claude')).toBe('var(--claude-color)');
  expect(providerColor('codex')).toBe('var(--codex-color)');
  expect(providerColor(null)).toBe('var(--text-tertiary)');
});
