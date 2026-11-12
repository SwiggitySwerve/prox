// Port of CPAMP's provider-rollup and search equivalence generators. Prox accepts UTC only.
import type { UsageAnalyticsQuery } from '../../server/usage/validate';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DUAL_RUN_START = Date.parse('2026-11-12T21:16:05Z');
export type MatrixMode = 'quick' | 'full';
export interface MatrixCase {
  id: string;
  family: 'rollup' | 'search';
  query: UsageAnalyticsQuery;
}
// Every term exercises a shared column. Project-only acct/proj terms in the Go fixture
// are replaced by session/trace terms; failure-summary-only "team " becomes a tier term.
export const SHARED_SEARCHES = [
  'needle',
  'NEEDLE',
  'Needle-Team',
  'ne',
  'n',
  'claude',
  'opus',
  '/v1/chat',
  'post',
  "o'brien",
  '"quoted"',
  '100%',
  'a_b',
  '%',
  '_',
  'ünï',
  'ÜNÏ',
  'session-needle',
  'trace-needle ',
  'priority',
  'nothing-matches',
  'req-1',
  'gpt',
  'e-t',
];
export function matrix(mode: MatrixMode, endMs: number): MatrixCase[] {
  const spans = [1, 6, 24, 7 * 24, 30 * 24, 31 * 24].flatMap((hours) => {
    const aligned = endMs - (endMs % HOUR);
    return [
      [endMs - hours * HOUR, endMs],
      [aligned - hours * HOUR, aligned],
    ];
  });
  const cases: MatrixCase[] = [];
  const add = (
    family: MatrixCase['family'],
    index: number,
    span: number[],
    granularity: 'hour' | 'day',
    provider: string,
    model: string,
    outcome: UsageAnalyticsQuery['outcome'],
    search: string
  ) => {
    cases.push({
      id: `${family}-${index}-${span[0]}-${span[1]}`,
      family,
      query: {
        from_ms: span[0],
        to_ms: span[1],
        time_zone: 'UTC',
        granularity,
        provider,
        model,
        outcome,
        search,
        limit: 3,
        catalog:
          family === 'rollup'
            ? [
                {
                  instance_id: 'instance',
                  instance_label: 'Instance',
                  provider: 'claude',
                  id: 'claude-only',
                },
              ]
            : [],
      },
    });
  };
  const rollupViews = ['hour', 'day', 'hour', 'day', 'hour', 'day', 'hour', 'day'] as const;
  let index = 0;
  for (const provider of ['', 'claude', 'CODEX', 'gemini', 'nobody'])
    for (const model of ['', 'shared-model'])
      for (const outcome of ['all', 'success', 'failed'] as const)
        for (const search of ['', 'needle']) {
          spans.forEach((span, i) => {
            if (mode === 'full' || (Math.floor(i / 2) + index) % 3 === 0)
              add(
                'rollup',
                index,
                span,
                rollupViews[(index + i) % rollupViews.length],
                provider,
                model,
                outcome,
                search
              );
          });
          index++;
        }
  const searchViews = ['hour', 'day', 'hour', 'day', 'hour'] as const;
  index = 0;
  for (const search of SHARED_SEARCHES)
    for (const provider of ['', 'claude', 'CODEX'])
      for (const model of ['', 'shared-model'])
        for (const outcome of ['all', 'success', 'failed'] as const) {
          spans.forEach((span, i) => {
            if (mode === 'full' || i === index % spans.length)
              add(
                'search',
                index,
                span,
                searchViews[(index + i) % searchViews.length],
                provider,
                model,
                outcome,
                search
              );
          });
          index++;
        }
  return cases;
}
/** Evenly spaced, deterministic smoke selection; no randomness or implicit live work. */
export function selectCases(cases: MatrixCase[], sample?: number): MatrixCase[] {
  if (sample === undefined || sample >= cases.length) return cases;
  if (!Number.isSafeInteger(sample) || sample < 1) throw new Error('Invalid sample size');
  return Array.from({ length: sample }, (_, i) => cases[Math.floor((i * cases.length) / sample)]);
}
export function previousUtcDay(nowMs: number) {
  const to_ms = Math.floor(nowMs / DAY) * DAY;
  return { from_ms: to_ms - DAY, to_ms };
}

// Coordinator-confirmed reconciliation: source generator arithmetic replaces stale plan counts.
export const MATRIX_RECONCILIATION = [
  {
    mode: 'quick',
    plan_count: 720,
    generated_base_queries: 240 + 432,
    arithmetic:
      '60 filter combinations × 4 rotating spans + 24 searches × 3 providers × 2 models × 3 outcomes = 240 + 432 = 672',
    maximum_pairs: 672 * 2,
    maximum_http_responses: 672 * 2 * 2,
    reason:
      'Plan count is not reproduced by the checked-in generators. 0 source cases dropped; time-zone slots mapped to UTC. Two pages × 672 = up to 1,344 pairs; two servers × 1,344 = 2,688 responses.',
  },
  {
    mode: 'full',
    plan_count: 22464,
    generated_base_queries: 720 + 5184,
    arithmetic:
      '60 filter combinations × 12 spans + 24 searches × 3 providers × 2 models × 3 outcomes × 12 spans = 720 + 5,184 = 5,904',
    maximum_pairs: 5904 * 2,
    maximum_http_responses: 5904 * 2 * 2,
    reason:
      'Plan count is not reproduced by the checked-in generators. 0 source cases dropped; time-zone slots mapped to UTC. Two pages × 5,904 = up to 11,808 pairs; two servers × 11,808 = 23,616 responses.',
  },
] as const;

export const GENERATOR_AXES = [
  {
    axis: 'Ranges',
    cpamp_rollup: '6 lengths × aligned/unaligned = 12; quick rotates 4',
    cpamp_search: 'same 12; quick rotates 1',
    harness: 'identical selections; caller window clipping reported separately',
  },
  {
    axis: 'Buckets/granularities',
    cpamp_rollup: 'hour/day in 8 rotating view slots (4/4)',
    cpamp_search: 'hour/day in 5 rotating view slots (3/2)',
    harness: 'same rotation; not an extra Cartesian factor',
  },
  { axis: 'Outcomes', cpamp_rollup: '3', cpamp_search: '3', harness: '3 in both families' },
  {
    axis: 'Providers',
    cpamp_rollup: '5: empty, claude, CODEX, gemini, nobody',
    cpamp_search: '3: empty, claude, CODEX',
    harness: 'same 5 / 3',
  },
  {
    axis: 'Models',
    cpamp_rollup: '2: empty, shared-model',
    cpamp_search: 'same 2',
    harness: 'same 2',
  },
  {
    axis: 'Search terms',
    cpamp_rollup: '2: empty, needle',
    cpamp_search: '24',
    harness:
      'same 2 / 24 slots; 3 search-fixture-only terms replaced with shared-column session, trace and tier terms',
  },
  {
    axis: 'Time zones',
    cpamp_rollup: '5 distinct zones in 8 coupled view slots',
    cpamp_search: '5 distinct zones in 5 coupled view slots',
    harness: '1 (UTC); all 8 / 5 slots preserved, 0 query cases removed',
  },
  {
    axis: 'Pages',
    cpamp_rollup: '1',
    cpamp_search: '1',
    harness: '1 plus page 2 when both have it; one-sided page 2 fails parity',
  },
] as const;

export const GENERATOR_SOURCE = {
  repository: 'CPA-Manager-Plus',
  commit: '52b12b45e010a766bd69ff55a55e566263d8bede',
  files: {
    'apps/manager-server/internal/service/monitoring/prox_provider_rollup_test.go':
      '2afc0df2b51c53f78baa4df9c2f201f92aaf0808',
    'apps/manager-server/internal/service/monitoring/prox_search_test.go':
      '0b739689d4f647356ea79aabaf0de4418127a1c4',
  },
} as const;
