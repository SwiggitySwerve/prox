// One read connection per active job. A killed/deadline worker never holds a snapshot for reuse.
import { openUsageReader } from './store';
import { queryAnalytics } from './analytics';
import { AnalyticsError } from './validate';
import type { QueryRequest, QueryReply } from './queryProtocol';

function reply(message: QueryReply) {
  if (typeof process.send === 'function') process.send(message);
  else self.postMessage(message);
}
function handle({ id, kind, body }: QueryRequest) {
  if (kind !== 'analytics') return;
  let db: ReturnType<typeof openUsageReader> | undefined;
  try {
    const checkDeadline = () => {
      if (Date.now() >= body.deadline) throw new AnalyticsError('Analytics deadline exceeded', 504);
    };
    checkDeadline();
    db = openUsageReader(body.dbPath);
    const response = queryAnalytics(db, body.query, body.rates, { checkDeadline });
    const json = JSON.stringify(response);
    checkDeadline();
    reply({ id, ok: true, body: json });
  } catch (error) {
    reply({
      id,
      ok: false,
      body: {
        error: error instanceof AnalyticsError ? error.message : 'Analytics query failed',
        status: error instanceof AnalyticsError ? error.status : 500,
      },
    });
  } finally {
    db?.close();
  }
}
if (typeof process.send === 'function')
  process.on('message', (message) => handle(message as QueryRequest));
else self.onmessage = (event: MessageEvent<QueryRequest>) => handle(event.data);
