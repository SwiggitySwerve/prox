// Evidence schema and rendering. Every compared value is retained; credentials never enter it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageAnalyticsQuery } from '../../server/usage/validate';
import type { ReconcileNote } from './reconcile';
import type { EventReport, Interval } from './events';
import { KNOWN_RESPONSE_RULES, type Difference } from './compare';
import {
  MATRIX_RECONCILIATION,
  GENERATOR_AXES,
  GENERATOR_SOURCE,
  type MatrixCase,
  type MatrixMode,
} from './matrix';

export interface ParityOptions {
  mode: MatrixMode;
  fromMs: number;
  toMs: number;
  level: 'both' | 'events' | 'responses';
  cpampDb: string;
  proxDb: string;
  cpampUrl: string;
  proxUrl: string;
  cpampKeyFile: string;
  proxKeyFile: string;
  rateBookFile: string;
  output: string;
  limit?: number;
  sample?: number;
  gapMs: number;
  deadlineMs?: number;
  outages: Interval[];
}
export interface ResponseResult {
  case_id: string;
  family: MatrixCase['family'];
  page: 1 | 2;
  cpamp_query: UsageAnalyticsQuery;
  prox_query: UsageAnalyticsQuery;
  differences: Difference[];
}
export interface ParityReport {
  schema_version: 1;
  started_at_ms: number;
  finished_at_ms?: number;
  window: { from_ms: number; to_ms: number };
  mode: MatrixMode;
  level: ParityOptions['level'];
  matrix: {
    source_cases: number;
    clipped_cases: number;
    outside_window_cases: number;
    generated_cases: number;
    selected_cases: number;
    planned_max_pairs: number;
    pairs_completed: number;
    http_responses: number;
    second_pages_absent_on_both: number;
    second_pages_limited: number;
    paging_mismatches: number;
    d5_replays: number;
    search_replays: number;
    limited: boolean;
  };
  matrix_reconciliation: typeof MATRIX_RECONCILIATION;
  generator_axes: typeof GENERATOR_AXES;
  generator_source: typeof GENERATOR_SOURCE;
  targets?: { cpamp: string; prox: string };
  response_counts: {
    compared: number;
    equal: number;
    unexplained: number;
    known_by_rule: Record<(typeof KNOWN_RESPONSE_RULES)[number], number>;
  };
  events?: EventReport;
  reconcile?: ReconcileNote;
  responses: ResponseResult[];
  event_differences: Difference[];
  counts: Record<Difference['class'], number>;
  complete: boolean;
  deadline_ms?: number;
  termination?: { kind: 'deadline' | 'forbidden-hours'; at_ms: number };
  status: 'running' | 'passed' | 'failed' | 'aborted' | 'incomplete';
  error?: string;
  io?: {
    queries: number;
    minimum_gap_ms: number;
    bytesRead: number;
    bytesWritten: number;
    pauseSeconds: number;
    longPauses: number;
  };
}
export function writeReport(report: ParityReport, prefix: string) {
  mkdirSync(join(prefix, '..'), { recursive: true });
  writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const lines = [
    `# Usage parity: ${report.status}`,
    '',
    `Complete: ${report.complete}. UTC deadline: ${report.deadline_ms === undefined ? 'none' : new Date(report.deadline_ms).toISOString()}.`,
    '',
    `UTC window: ${new Date(report.window.from_ms).toISOString()} to ${new Date(report.window.to_ms).toISOString()}.`,
    '',
    `Matrix ${report.mode}: ${report.matrix.generated_cases} generated cases; ${report.matrix.selected_cases} selected; ` +
      `${report.matrix.pairs_completed}/${report.matrix.planned_max_pairs} maximum pairs completed ` +
      `(${report.matrix.http_responses} HTTP responses; ${report.matrix.second_pages_absent_on_both} second pages absent on both; ${report.matrix.paging_mismatches} paging mismatches).`,
    `Limited/sample run: ${report.matrix.limited ? 'yes; not a cutover gate' : 'no'}. D5 local replays: ${report.matrix.d5_replays}; search-cpamp-only replays: ${report.matrix.search_replays}.`,
    '',
    '| Mode | Plan count | Generated base queries | Maximum pages/pairs/responses | Reconciliation |',
    '| --- | ---: | --- | --- | --- |',
    ...report.matrix_reconciliation.map(
      (row) =>
        `| ${row.mode} | ${row.plan_count.toLocaleString('en-US')} | ${row.arithmetic} | 2 pages × ${row.generated_base_queries} = ${row.maximum_pairs} pairs; × 2 servers = ${row.maximum_http_responses} responses | ${row.reason} |`
    ),
    '',
    `Generator source: CPA-Manager-Plus commit ${report.generator_source.commit}. Both source files were clean at this commit; blob IDs are in the JSON. No alternate generator version explaining the plan counts was identified.`,
    '',
    '| Axis | CPAMP rollup generator | CPAMP search generator | Harness |',
    '| --- | --- | --- | --- |',
    ...report.generator_axes.map(
      (row) => `| ${row.axis} | ${row.cpamp_rollup} | ${row.cpamp_search} | ${row.harness} |`
    ),
    '',
    `Window adjustments: ${report.matrix.clipped_cases} cases clipped to requested start; ${report.matrix.outside_window_cases} cases entirely outside requested window. Source cases: ${report.matrix.source_cases}.`,
    '',
    `Compared pairs: ${report.response_counts.compared}; equal: ${report.response_counts.equal}; unexplained: ${report.response_counts.unexplained}.`,
    '',
    ...Object.entries(report.response_counts.known_by_rule).map(
      ([rule, n]) => `- Known ${rule}: ${n} pairs`
    ),
    '',
    'Pair rule counts can overlap. The following counts are individual differing fields/events:',
    '',
    ...(report.events
      ? [
          `Events: ${report.events.matched} matched (${report.events.exact_matched} exact); ${report.events.cpamp_rows} CPAMP / ` +
            `${report.events.prox_rows} Prox; ${report.events.gaps.length} recorded gap intervals; complete=${report.events.complete}.`,
          `Matched by ingest: ${JSON.stringify(report.events.matched_by_ingest)}. Reverse-only rows outside the subscribed cohort: ${JSON.stringify(report.events.reverse_only_omitted_by_ingest)}.`,
          '',
        ]
      : []),
    ...(report.reconcile
      ? [`Reconcile before comparison: ${report.reconcile.status}. ${report.reconcile.message}`, '']
      : []),
    ...Object.entries(report.counts).map(([kind, count]) => `- ${kind}: ${count}`),
    '',
    ...(report.error ? [`Failure: ${report.error}`, ''] : []),
    'The JSON contains every difference with both values and the two queries/cursors. Known differences are counted, not discarded.',
    '',
  ];
  writeFileSync(`${prefix}.md`, lines.join('\n'), { mode: 0o600 });
}
export function createReport(options: ParityOptions, nowMs: number): ParityReport {
  return {
    schema_version: 1,
    started_at_ms: nowMs,
    window: { from_ms: options.fromMs, to_ms: options.toMs },
    mode: options.mode,
    level: options.level,
    matrix: {
      source_cases: 0,
      clipped_cases: 0,
      outside_window_cases: 0,
      generated_cases: 0,
      selected_cases: 0,
      planned_max_pairs: 0,
      pairs_completed: 0,
      http_responses: 0,
      second_pages_absent_on_both: 0,
      second_pages_limited: 0,
      paging_mismatches: 0,
      d5_replays: 0,
      search_replays: 0,
      limited: false,
    },
    matrix_reconciliation: MATRIX_RECONCILIATION,
    generator_axes: GENERATOR_AXES,
    generator_source: GENERATOR_SOURCE,
    response_counts: {
      compared: 0,
      equal: 0,
      unexplained: 0,
      known_by_rule: Object.fromEntries(
        KNOWN_RESPONSE_RULES.map((rule) => [rule, 0])
      ) as ParityReport['response_counts']['known_by_rule'],
    },
    responses: [],
    event_differences: [],
    status: 'running',
    complete: false,
    deadline_ms: options.deadlineMs,
    counts: {
      unexplained: 0,
      'd5-pricing': 0,
      'search-cpamp-only': 0,
      'detail-provider': 0,
      'detail-trace': 0,
      'coverage-limitations': 0,
      'drained-during-cpamp-outage': 0,
      'ingest-gap': 0,
      'ttft-zero-null': 0,
    },
  };
}
