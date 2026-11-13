// Orchestrates frozen queries, per-backend cursors, read-only D5 witnesses and evidence output.
import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { AnalyticsResponse } from '../../src/domain/analytics/types';
import { queryAnalytics } from '../../server/usage/analytics';
import type { CpampSearchReplay } from '../../server/usage/search';
import { parseRateBook, priceRevision, type RateBookState } from '../../server/usage/rates';
import { validateAnalyticsQuery, type UsageAnalyticsQuery } from '../../server/usage/validate';
import { compareEvents, createEventReport, openParityReader } from './events';
import {
  compareResponses,
  D5_MODELS,
  type D5Witness,
  needsD5Witness,
  KNOWN_RESPONSE_RULES,
  type Difference,
} from './compare';
import { matrix, selectCases, type MatrixCase } from './matrix';
import { cpampOnlySearchExecutions } from './searchCpampOnly';
import { QueryGate } from './io';
import { observeReconcile, confirmWindow } from './reconcile';
import { ExecutionWindow, IncompleteRun } from './window';
import {
  createReport,
  writeReport,
  type ParityOptions,
  type ParityReport,
  type ResponseResult,
} from './report';
export type { ParityOptions, ParityReport } from './report';
export { writeReport } from './report';

function readCredential(path: string): string {
  const key = readFileSync(path, 'utf8').trim();
  if (!key) throw new Error('Empty analytics credential');
  return key;
}
export function assertLoopbackEndpoint(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error('Analytics endpoint must be loopback HTTP');
}
async function post(
  url: string,
  key: string,
  query: UsageAnalyticsQuery,
  gate: QueryGate,
  received: () => void
): Promise<AnalyticsResponse> {
  return gate.run(async () => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.any([gate.signal, AbortSignal.timeout(30_000)]),
    });
    received();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Analytics HTTP ${response.status}`);
    }
    const value = (await response.json()) as AnalyticsResponse;
    if (
      !value ||
      value.schema_version !== 1 ||
      !value.coverage ||
      !value.requests ||
      !Array.isArray(value.requests.items) ||
      !Array.isArray(value.rates) ||
      !Array.isArray(value.models) ||
      !Array.isArray(value.providers) ||
      !Array.isArray(value.timeline)
    )
      throw new Error('Invalid analytics response shape');
    return value;
  });
}
function nextQuery(
  q: UsageAnalyticsQuery,
  response: AnalyticsResponse
): UsageAnalyticsQuery | null {
  const { has_more: more, next_before_ms: ms, next_before_id: id } = response.requests;
  if (!more) return null;
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(id) || ms === null || id === null)
    throw new Error('Invalid analytics page cursor');
  return { ...q, before_ms: ms, before_id: id };
}
/** Prox event sequence numbers for CPAMP execution IDs, or null if any one is absent. */
function targetSeqs(db: Database, executions: readonly string[]): number[] | null {
  const seqs: number[] = [];
  for (let first = 0; first < executions.length; first += 500) {
    const part = executions.slice(first, first + 500);
    seqs.push(
      ...db
        .query<{ seq: number }, string[]>(
          `SELECT seq FROM event_detail WHERE execution_id IN (${part.map(() => '?').join(',')})`
        )
        .all(...part)
        .map((row) => row.seq)
    );
  }
  return seqs.length === executions.length ? seqs : null;
}
function loadWitnessBooks(path: string): { priced: RateBookState; unpriced: RateBookState } {
  const book = parseRateBook(JSON.parse(readFileSync(path, 'utf8')));
  const models = { ...book.models };
  D5_MODELS.forEach((name) => {
    delete models[name];
  });
  const unpricedBook = { ...book, models };
  const now = Date.now();
  const state = (b: typeof book): RateBookState => ({
    book: b,
    price_revision: priceRevision(b),
    loaded_at_ms: now,
    checked_at_ms: now,
    error: null,
  });
  return { priced: state(book), unpriced: state(unpricedBook) };
}
export async function runParity(
  options: ParityOptions,
  signal: AbortSignal,
  dependencies: { gate?: QueryGate; nowMs?: number; wallNow?: () => number } = {}
): Promise<ParityReport> {
  const now = dependencies.nowMs ?? Date.now();
  const report = createReport(options, now);
  const gate = dependencies.gate ?? new QueryGate(signal, options.gapMs);
  const window = new ExecutionWindow(
    signal,
    options.deadlineMs,
    dependencies.wallNow ?? (() => dependencies.nowMs ?? Date.now())
  );
  gate.setWindow(window);
  let proxKey: string | undefined;
  const getProxKey = () => (proxKey ??= readCredential(options.proxKeyFile));
  let source: Database | undefined, target: Database | undefined, cpampReader: Database | undefined;
  const record = (difference: Difference) => {
    report.counts[difference.class]++;
  };
  try {
    window.check();
    if (
      !Number.isSafeInteger(options.fromMs) ||
      !Number.isSafeInteger(options.toMs) ||
      options.fromMs <= 0 ||
      options.fromMs >= options.toMs ||
      options.toMs > now - 600_000
    )
      throw new Error('Window must be fixed and end at least 10 minutes ago');
    for (const count of [options.limit, options.sample])
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 1))
        throw new Error('Invalid limit/sample');
    assertLoopbackEndpoint(options.cpampUrl);
    assertLoopbackEndpoint(options.proxUrl);
    report.targets = { cpamp: options.cpampUrl, prox: options.proxUrl };
    const getTarget = async () =>
      (target ??= await gate.run(() => openParityReader(options.proxDb)));
    if (options.level !== 'responses') {
      report.reconcile = await observeReconcile(options.proxUrl, getProxKey, gate, window.now);
      source = await gate.run(() => openParityReader(options.cpampDb));
      await getTarget();
      report.events = createEventReport(options.fromMs, options.toMs);
      await compareEvents(
        source,
        target!,
        options.fromMs,
        options.toMs,
        gate,
        (difference) => {
          report.event_differences.push(difference);
        },
        options.outages,
        report.events
      );
      report.reconcile = confirmWindow(report.reconcile, report.events);
      source.close();
      source = undefined;
    }
    if (options.level !== 'events') {
      // Read bearer files only into private process memory; never include them in the report/errors.
      const cpampKey = readCredential(options.cpampKeyFile);
      const proxKey = getProxKey();
      const sourceCases = matrix(options.mode, options.toMs);
      report.matrix.source_cases = sourceCases.length;
      report.matrix.clipped_cases = sourceCases.filter(
        (c) => c.query.from_ms < options.fromMs && c.query.to_ms > options.fromMs
      ).length;
      report.matrix.outside_window_cases = sourceCases.filter(
        (c) => c.query.to_ms <= options.fromMs
      ).length;
      const all = sourceCases
        .map((item) => ({
          ...item,
          query: {
            ...item.query,
            from_ms: Math.max(item.query.from_ms, options.fromMs),
          },
        }))
        .filter((item) => item.query.from_ms < item.query.to_ms);
      const selected = selectCases(all, options.sample);
      const maxPairs = Math.min(selected.length * 2, options.limit ?? Infinity);
      Object.assign(report.matrix, {
        generated_cases: all.length,
        selected_cases: selected.length,
        planned_max_pairs: maxPairs,
        limited: selected.length !== all.length || maxPairs < selected.length * 2,
      });
      let books: ReturnType<typeof loadWitnessBooks> | undefined;
      const pair = async (
        item: MatrixCase,
        page: 1 | 2,
        cq: UsageAnalyticsQuery,
        pq: UsageAnalyticsQuery
      ) => {
        validateAnalyticsQuery(cq);
        validateAnalyticsQuery(pq);
        const received = () => {
          report.matrix.http_responses++;
        };
        const cpamp = await post(options.cpampUrl, cpampKey, cq, gate, received);
        const prox = await post(options.proxUrl, proxKey, pq, gate, received);
        let differences = compareResponses(cpamp, prox);
        const result: ResponseResult = {
          case_id: item.id,
          family: item.family,
          page,
          cpamp_query: cq,
          prox_query: pq,
          differences,
        };
        report.responses.push(result);
        report.matrix.pairs_completed++;
        let replayMore: { cpamp: boolean; prox: boolean } | undefined;
        const d5 = needsD5Witness(differences);
        const search =
          !!pq.search?.trim() && differences.some((difference) => difference.class === 'unexplained');
        if (d5 || search) {
          books ??= loadWitnessBooks(options.rateBookFile);
          const db = await getTarget();
          const replay = async (
            state: RateBookState,
            query: UsageAnalyticsQuery,
            cpampSearch?: CpampSearchReplay
          ) =>
            gate.run(() => {
              const deadline = performance.now() + 30_000;
              const response = queryAnalytics(db, query, state, {
                cpampSearch,
                checkDeadline: () => {
                  window.check();
                  if (performance.now() >= deadline) throw new Error('D5 replay deadline exceeded');
                },
              });
              if (cpampSearch || !d5) report.matrix.search_replays++;
              else report.matrix.d5_replays++;
              return response;
            }, true);
          const witness: D5Witness = {};
          // The plain replay is Prox's expected value for both the D5 and the search rules.
          witness.priced = await replay(books.priced, pq);
          if (d5) witness.unpriced = await replay(books.unpriced, pq);
          if (search) {
            // CPAMP's own database says which events its search document alone matches.
            cpampReader ??= await gate.run(() => openParityReader(options.cpampDb));
            const reader = cpampReader;
            const executions = await gate.run(() => cpampOnlySearchExecutions(reader, pq), true);
            const seqs = executions ? await gate.run(() => targetSeqs(db, executions), true) : null;
            if (seqs) {
              // Search as CPAMP's document does, plus exactly those events. The replay's own
              // first page says where CPAMP's second page would start.
              const as = { alsoMatchSeqs: seqs };
              const next =
                page === 2 ? nextQuery(item.query, await replay(books.priced, item.query, as)) : null;
              const wq = page === 2 ? (next ?? pq) : pq;
              witness.matched = await replay(books.priced, wq, as);
              replayMore = {
                cpamp: witness.matched.requests.has_more,
                prox: witness.priced.requests.has_more,
              };
              if (d5) witness.unpricedMatched = await replay(books.unpriced, wq, as);
            }
          }
          differences = compareResponses(cpamp, prox, witness);
        }
        result.differences = differences;
        return { cpamp, prox, replayMore };
      };
      for (const item of selected) {
        window.check();
        if (report.matrix.pairs_completed >= maxPairs) break;
        const first = await pair(item, 1, item.query, item.query);
        const cq = nextQuery(item.query, first.cpamp),
          pq = nextQuery(item.query, first.prox);
        if (Boolean(cq) !== Boolean(pq)) {
          // A search replay that searches as CPAMP does says whether CPAMP had a second page.
          const more = first.replayMore;
          const explained =
            more !== undefined && Boolean(cq) === more.cpamp && Boolean(pq) === more.prox;
          const mismatch: Difference = {
            class: explained ? 'search-cpamp-only' : 'unexplained',
            path: '$.requests.second_page',
            cpamp: { available: Boolean(cq) },
            prox: { available: Boolean(pq) },
          };
          report.responses.at(-1)!.differences.push(mismatch);
          if (explained) report.matrix.second_pages_limited++;
          else report.matrix.paging_mismatches++;
        } else if (cq && pq) {
          if (report.matrix.pairs_completed < maxPairs) await pair(item, 2, cq, pq);
          else report.matrix.second_pages_limited++;
        } else report.matrix.second_pages_absent_on_both++;
      }
    }
    window.check();
    report.complete = true;
    report.status = [
      ...report.event_differences,
      ...report.responses.flatMap((r) => r.differences),
    ].some((d) => d.class === 'unexplained')
      ? 'failed'
      : 'passed';
  } catch (error) {
    const stopped = window.signal.reason;
    if (stopped instanceof IncompleteRun) {
      report.status = 'incomplete';
      report.termination = { kind: stopped.kind, at_ms: stopped.atMs };
      report.error = stopped.message;
    } else report.status = signal.aborted ? 'aborted' : 'failed';
    // Fetch/JSON/SQLite errors can contain arbitrary body text or private paths. Keep a fixed
    // allowlist of our own diagnostics; never dump an Error, Request, options or response body.
    const message = error instanceof Error ? error.message : '';
    report.error ??=
      /^(Analytics HTTP \d{3}|Invalid analytics (response shape|page cursor)|Window must be fixed and end at least 10 minutes ago|Invalid limit\/sample|Analytics endpoint must be loopback HTTP|Empty analytics credential|D5 replay deadline exceeded)$/.test(
        message
      )
        ? message
        : signal.aborted
          ? 'Interrupted; partial evidence only'
          : 'Parity operation failed; inspect paths, schemas, credentials and service availability';
  } finally {
    window.close();
    source?.close();
    cpampReader?.close();
    target?.close();
    [...report.event_differences, ...report.responses.flatMap((r) => r.differences)].forEach(
      record
    );
    report.response_counts.compared = report.responses.length;
    report.response_counts.equal = report.responses.filter((r) => !r.differences.length).length;
    report.response_counts.unexplained = report.responses.filter((r) =>
      r.differences.some((d) => d.class === 'unexplained')
    ).length;
    for (const rule of KNOWN_RESPONSE_RULES)
      report.response_counts.known_by_rule[rule] = report.responses.filter((r) =>
        r.differences.some((d) => d.class === rule)
      ).length;
    report.finished_at_ms = dependencies.wallNow?.() ?? dependencies.nowMs ?? Date.now();
    report.io = { queries: gate.queries, minimum_gap_ms: options.gapMs, ...gate.governor.counters };
    writeReport(report, options.output);
  }
  return report;
}

export function parityExitCode(report: ParityReport): number {
  return report.status === 'passed'
    ? 0
    : report.status === 'incomplete'
      ? 2
      : report.status === 'aborted'
        ? 130
        : 1;
}
