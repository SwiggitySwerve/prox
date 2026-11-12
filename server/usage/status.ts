// Loopback HTTP presentation of collection and writer state; all database work is elsewhere.
import { authorized } from '../http/auth';
import type { SourceStatus } from './collector';
import type { WriterStatus } from './writerProtocol';

export function createUsageStatusHandler(options: {
  keyFile: string;
  sources: () => readonly SourceStatus[];
  writer: () => WriterStatus;
  healthy: () => boolean;
}): (request: Request) => Response {
  return (request) => {
    const path = new URL(request.url).pathname;
    const json = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (path === '/healthz') return json({ ok: options.healthy() }, options.healthy() ? 200 : 503);
    if (path !== '/v1/status') return json({ error: 'Not found' }, 404);
    try {
      if (!authorized(request, options.keyFile)) return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Management key unavailable' }, 503);
    }
    return json({ sources: options.sources(), writer: options.writer() });
  };
}
