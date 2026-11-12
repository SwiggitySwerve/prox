// Loopback HTTP presentation of collection and writer state; all database work is elsewhere.
import { authorized } from '../http/auth';
import type { SourceStatus } from './collector';
import {
  isBulkJobKind,
  type BulkJobKind,
  type BulkJobReport,
  type WriterStatus,
} from './writerProtocol';

interface JobControls {
  startJob(kind: BulkJobKind): Promise<BulkJobReport>;
  cancelJob(jobId: number): Promise<BulkJobReport>;
  jobReport(): Promise<BulkJobReport | null>;
}

/** Admin commands are small objects; bound streamed bodies too, regardless of Content-Length. */
async function command(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing command');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024) throw new Error('Command too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid command');
  return parsed as Record<string, unknown>;
}

export function createUsageStatusHandler(options: {
  keyFile: string;
  sources: () => readonly SourceStatus[];
  writer: () => WriterStatus;
  healthy: () => boolean;
  jobs?: JobControls;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const json = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    if (path === '/healthz') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return json({ ok: options.healthy() }, options.healthy() ? 200 : 503);
    }
    if (!['/v1/status', '/v1/jobs', '/v1/jobs/cancel'].includes(path)) {
      return json({ error: 'Not found' }, 404);
    }
    try {
      if (!authorized(request, options.keyFile)) return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Management key unavailable' }, 503);
    }
    if (request.method === 'GET' && path !== '/v1/jobs/cancel') {
      try {
        const job = (await options.jobs?.jobReport()) ?? null;
        if (path === '/v1/jobs') return json({ job });
        return json({ sources: options.sources(), writer: { ...options.writer(), job } });
      } catch {
        return json({ error: 'Usage writer unavailable' }, 503);
      }
    }
    if (request.method !== 'POST' || path === '/v1/status') {
      return json({ error: 'Method not allowed' }, 405);
    }
    if (!options.healthy() || !options.jobs) return json({ error: 'Jobs unavailable' }, 503);
    let body: Record<string, unknown>;
    try {
      body = await command(request);
      if (Object.keys(body).length !== 1) throw new Error('Unknown command fields');
      if (path === '/v1/jobs') {
        if (!isBulkJobKind(body.kind)) {
          throw new Error('Invalid job kind');
        }
      } else if (!Number.isSafeInteger(body.jobId) || Number(body.jobId) < 1) {
        throw new Error('Invalid job ID');
      }
    } catch {
      return json({ error: 'Invalid job command' }, 400);
    }
    try {
      const job =
        path === '/v1/jobs'
          ? await options.jobs.startJob(body.kind as BulkJobKind)
          : await options.jobs.cancelJob(body.jobId as number);
      return json({ job }, 202);
    } catch {
      return json({ error: 'Bulk job unavailable or ID differs' }, 409);
    }
  };
}
