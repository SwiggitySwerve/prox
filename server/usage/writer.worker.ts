// The only write connections live here. Main-thread code refers to this entry by runtime path.
import { UsageStore } from './store';
import { normalizeUsagePayload } from './normalize';
import { createRateBookLoader } from './rates';
import { WriterQueue } from './writerQueue';
import { QUEUE_RETENTION_MS, type WriterRequest, type WriterStatus } from './writerProtocol';
import type { IngestItem } from './types';

const queue = new WriterQueue();
/** P3 plugs bounded import, backup and prune chunks into this same queue inside the worker. */
export const enqueueJob = queue.enqueueJob.bind(queue);
let store: UsageStore | null = null;
let maintenance: ReturnType<typeof setTimeout> | null = null;
let closing = false;
function startRollups(path?: string) {
  const loader = createRateBookLoader(path ?? '/data/usage-rates.json');
  const schedule = () => {
    if (closing) return;
    maintenance = setTimeout(() => {
      maintenance = null;
      // At most one background hour is pending. Yield to the worker event loop between jobs
      // so incoming live messages can enter the live-first queue, even after a bulk import.
      void enqueueJob('rollup', () => {
        if (!store || closing) return;
        const book = loader.load().book ?? { version: 1 as const, models: {} };
        store.rebuildNextHour(book);
      })
        .catch(() => {
          // Replacement is transactional; failed hours remain raw and retry on the next tick.
          console.error('Usage hourly rollup rebuild failed; raw events retained');
        })
        .finally(schedule);
    }, 1000);
  };
  schedule();
}
const status: WriterStatus = {
  backlog: 0,
  inserted: 0,
  duplicates: 0,
  rejected: 0,
  rawBufferFailures: 0,
  gaps: 0,
};

self.onmessage = (event: MessageEvent<WriterRequest>) => {
  const { id, kind, body } = event.data;
  if (kind === 'close') {
    closing = true;
    if (maintenance) clearTimeout(maintenance);
    maintenance = null;
  }
  if (kind === 'live') status.backlog += body.length;
  void enqueueJob(kind, () => {
    if (kind === 'init') {
      if (store) throw new Error('Writer already initialized');
      store = new UsageStore({ events: body.events, raw: body.raw });
      for (const instance of body.sources) {
        const heartbeat = Number(store.getMeta(`heartbeat:${instance}`));
        if (heartbeat > 0 && body.nowMs - heartbeat > QUEUE_RETENTION_MS) {
          store.recordGap({
            instance,
            fromMs: heartbeat,
            toMs: body.nowMs - QUEUE_RETENTION_MS,
            reason: 'stale-heartbeat',
          });
        }
      }
      status.gaps = store.gapCount();
      startRollups(body.rateBookPath);
    } else {
      if (!store) throw new Error('Writer not initialized');
      if (kind === 'live') {
        // Group only consecutive records of the same transport, retaining their ingestion order.
        let items: IngestItem[] = [];
        let ingest = body[0]?.ingest ?? 0;
        const commit = () => {
          if (!items.length) return;
          const result = store!.insert(items, ingest);
          status.inserted += result.inserted;
          status.duplicates += result.duplicates;
          items = [];
        };
        for (const item of body) {
          if (item.ingest !== ingest) {
            commit();
            ingest = item.ingest;
          }
          const result = normalizeUsagePayload(item.payload, () => item.label);
          if (result.kind === 'event') items.push({ event: result.event, raw: result.raw });
          else if (result.kind === 'rejected') {
            status.rejected += 1;
            store.recordRejected(result.reason, result.raw);
          }
        }
        commit();
        status.backlog -= body.length;
      } else if (kind === 'gap') {
        store.recordGap(body);
        status.gaps += 1;
      } else if (kind === 'heartbeat') {
        store.setMeta(`heartbeat:${body.instance}`, String(body.atMs));
      }
      status.rawBufferFailures = store.rawBufferFailures;
      if (kind === 'close') {
        store.close();
        store = null;
      }
    }
    self.postMessage({ id, ok: true, body: { ...status } });
  }).catch(() => {
    // An event DB failure is fatal to the bridge; it must stop collection instead of losing a batch.
    self.postMessage({ id, ok: false, body: { error: 'Usage writer job failed' } });
  });
};
