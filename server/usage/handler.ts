// Authenticated HTTP boundary and worker RPC. This module must never import a SQLite owner.
import { authorized } from '../http/auth';
import { createAnalyticsLanes, type QueryExecutor } from './lanes';
import { createRateBookLoader, type RateBookState } from './rates';
import { AnalyticsError, parseAnalyticsQuery } from './validate';
import type { QueryReply, QueryRequest } from './queryProtocol';

export function queryWorkerPath(): string {
  const extension = import.meta.path.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./query.worker.${extension}`, import.meta.url).pathname;
}
function workerExecutor(dbPath: string, rates: () => RateBookState, path: string) {
  let worker: Worker | null = null;
  let nextId = 0;
  const execute: QueryExecutor<string> = (query, deadline, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AnalyticsError('Request cancelled', 499));
        return;
      }
      const current = (worker ??= new Worker(path));
      const id = ++nextId;
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        current.removeEventListener('message', receive);
        current.removeEventListener('error', fail);
        current.removeEventListener('close', fail);
      };
      const fail = () => {
        cleanup();
        current.terminate();
        worker = null;
        reject(new AnalyticsError('Analytics worker unavailable', 503));
      };
      const abort = () => {
        cleanup();
        current.terminate();
        worker = null;
        reject(signal.reason ?? new AnalyticsError('Request cancelled', 499));
      };
      const receive = ({ data }: MessageEvent<QueryReply>) => {
        if (data.id !== id) return;
        cleanup();
        if (data.ok) resolve(data.body);
        else reject(new AnalyticsError(data.body.error, data.body.status));
      };
      current.addEventListener('message', receive);
      current.addEventListener('error', fail);
      current.addEventListener('close', fail);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const message: QueryRequest = {
          id,
          kind: 'analytics',
          body: { dbPath, query, deadline, rates: rates() },
        };
        current.postMessage(message);
      } catch {
        fail();
      }
    });
  return {
    execute,
    close() {
      worker?.terminate();
      worker = null;
    },
  };
}
// CPAMP caps JSON bodies at 1 MiB. Bound streamed bodies too, before parsing or admission.
async function readQueryBody(request: Request, deadline: number): Promise<string> {
  if (!request.body) return '';
  if (request.signal.aborted) throw new AnalyticsError('Request cancelled', 499);
  const reader = request.body.getReader();
  let reject!: (error: AnalyticsError) => void;
  const cancelled = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const stop = (error: AnalyticsError) => {
    reject(error);
    void reader.cancel().catch(() => {});
  };
  const abort = () => stop(new AnalyticsError('Request cancelled', 499));
  const timer = setTimeout(
    () => stop(new AnalyticsError('Analytics deadline exceeded', 504)),
    Math.max(0, deadline - Date.now())
  );
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), cancelled]);
      if (request.signal.aborted) throw new AnalyticsError('Request cancelled', 499);
      if (Date.now() >= deadline) throw new AnalyticsError('Analytics deadline exceeded', 504);
      if (done) break;
      length += value.byteLength;
      if (length > 1 << 20) {
        void reader.cancel().catch(() => {});
        throw new AnalyticsError('Analytics body exceeds 1 MiB', 400);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
export const ANALYTICS_PATHS = ['/v1/analytics', '/v0/management/monitoring/prox-analytics'];
export function createAnalyticsHandler(options: {
  dbPath: string;
  keyFile: string;
  rateBook?: { load(): RateBookState };
  rateBookPath?: string;
  workerPath?: string;
}) {
  const loader =
    options.rateBook ?? createRateBookLoader(options.rateBookPath ?? '/data/usage-rates.json');
  const fast = workerExecutor(
    options.dbPath,
    () => loader.load(),
    options.workerPath ?? queryWorkerPath()
  );
  const search = workerExecutor(
    options.dbPath,
    () => loader.load(),
    options.workerPath ?? queryWorkerPath()
  );
  const lanes = createAnalyticsLanes({ fast: fast.execute, search: search.execute });
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json',
  };
  const handler = async (request: Request): Promise<Response> => {
    const deadline = Date.now() + 30000;
    const error = (message: string, status: number) =>
      Response.json({ error: message }, { status, headers });
    if (!ANALYTICS_PATHS.includes(new URL(request.url).pathname)) return error('Not found', 404);
    if (request.method !== 'POST') return error('Method not allowed', 405);
    try {
      if (!authorized(request, options.keyFile)) return error('Unauthorized', 401);
    } catch {
      return error('Management key unavailable', 503);
    }
    try {
      const query = parseAnalyticsQuery(await readQueryBody(request, deadline));
      const result = await lanes.query(query, { deadline, signal: request.signal });
      return new Response(result, { status: 200, headers });
    } catch (cause) {
      return cause instanceof AnalyticsError
        ? error(cause.message, cause.status)
        : error('Analytics unavailable', 500);
    }
  };
  return Object.assign(handler, {
    close() {
      lanes.close();
      fast.close();
      search.close();
    },
  });
}
