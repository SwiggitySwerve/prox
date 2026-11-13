// The only write connections live here. Main-thread code refers to this entry by runtime path.
import { UsageExporter } from './exporter';
import { DEFAULT_CLIENT_ALIASES_PATH, createClientAliasLoader } from './clientAliases';
import { createRateBookLoader, DEFAULT_RATE_BOOK_PATH } from './rates';
import { UsageStore } from './store';
import { normalizeUsagePayload } from './normalize';
import { WriterQueue } from './writerQueue';
import {
  isBulkJobKind,
  type UsagePayload,
  type WriterRequest,
  type WriterStatus,
} from './writerProtocol';
import type { IngestItem } from './types';
import { startHourlyRollups } from './rollupMaintenance';
import { UsageBulkJobs } from './bulkJobs';
import type { IoGovernorOptions } from './ioGovernor';

export function startUsageWriterWorker(governorOptions: IoGovernorOptions = {}): void {
  const queue = new WriterQueue();
  /** P3 plugs bounded import, backup and prune chunks into this same queue inside the worker. */
  const enqueueJob = queue.enqueueJob.bind(queue);
  let store: UsageStore | null = null;
  let jobs: UsageBulkJobs | null = null;
  let closing = false;
  let rollups: ReturnType<typeof startHourlyRollups> | null = null;
  let exporter: UsageExporter | null = null;
  let rates: ReturnType<typeof createRateBookLoader> | null = null;
  let aliases: ReturnType<typeof createClientAliasLoader> | null = null;
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
    const bulk = isBulkJobKind(kind) || kind === 'cancel' || kind === 'job-status';
    const reply = () =>
      self.postMessage({ id, ok: true, body: { ...status, job: jobs?.report() ?? null } });
    if (bulk) {
      try {
        if (!jobs || closing) throw new Error('Writer unavailable');
        if (kind === 'cancel') jobs.cancel(body.jobId, body.clientToken);
        else if (isBulkJobKind(kind))
          jobs.start(kind, body && 'clientToken' in body ? body.clientToken : undefined);
        reply();
      } catch {
        self.postMessage({
          id,
          ok: false,
          body: { error: 'Bulk job unavailable or ID differs', fatal: false },
        });
      }
      return;
    }
    if (kind === 'close') {
      closing = true;
      // Never hold the writer queue while a job unwinds a PSI wait or aborted upload.
      void (async () => {
        await Promise.all([rollups?.close(), jobs?.close()]);
        await enqueueJob('close', () => {
          store?.close();
          store = null;
        });
        reply();
      })().catch(() =>
        self.postMessage({ id, ok: false, body: { error: 'Writer close failed', fatal: true } })
      );
      return;
    }
    if (kind === 'exporter') {
      void enqueueJob('exporter', () => {
        if (!exporter || !rates || !aliases || closing) throw new Error('Exporter unavailable');
        const rateState = rates.load();
        const aliasState = aliases.load();
        exporter.refresh(rateState.book);
        self.postMessage({
          id,
          ok: true,
          body: {
            ...status,
            exporter: {
              ...exporter.snapshot(aliasState.aliases),
              rate_book_error: !!rateState.error,
              rate_book_loaded: rateState.book !== null,
              client_alias_error: aliasState.error,
              client_aliases_loaded: aliasState.loaded,
            },
          },
        });
      }).catch(() =>
        self.postMessage({
          id,
          ok: false,
          body: { error: 'Usage exporter unavailable', fatal: false },
        })
      );
      return;
    }
    if (kind === 'live') status.backlog += body.length;
    void enqueueJob(kind === 'replay' ? 'live' : kind, () => {
      if (kind === 'init') {
        if (store) throw new Error('Writer already initialized');
        store = new UsageStore({ events: body.events, raw: body.raw });
        // Freeze cursorless receipt boundaries before init returns and subscriptions start.
        // A persisted heartbeat can be ahead of now after a backward wall-clock step.
        for (const instance of body.sources) {
          const savedHeartbeat = store.getMeta(`heartbeat:${instance}`);
          if (savedHeartbeat === null) continue;
          const heartbeat = Number(savedHeartbeat);
          const cursorless = store.getCursor(instance) === null;
          if (cursorless || heartbeat < body.nowMs) {
            store.recordRecovery(
              {
                instance,
                fromMs: heartbeat,
                toMs: body.nowMs,
                reason: 'stale-heartbeat',
              },
              cursorless
            );
          }
        }
        status.gaps = store.gapCount();
        rates = createRateBookLoader(body.exporter?.rateBookPath ?? DEFAULT_RATE_BOOK_PATH);
        aliases = createClientAliasLoader(
          body.exporter?.clientAliasesPath ?? DEFAULT_CLIENT_ALIASES_PATH
        );
        exporter = new UsageExporter((visit) => store!.scanExporterEvents(visit));
        exporter.refresh(rates.load().book);
        store.onCommit = (events) => {
          try {
            for (const event of events) exporter!.add(event);
          } catch {
            // A projection failure never turns a committed event into a failed live batch.
            exporter!.invalidate();
          }
        };
        jobs = new UsageBulkJobs(store, enqueueJob, body.jobs, governorOptions);
        rollups = startHourlyRollups(store, jobs, body.rateBookPath ?? body.exporter?.rateBookPath);
      } else {
        if (!store) throw new Error('Writer not initialized');
        if (kind === 'live' || kind === 'replay') {
          const payloads = kind === 'live' ? body : body.payloads;
          const groups: UsagePayload[][] = [];
          for (const item of payloads) {
            const group = groups[groups.length - 1];
            if (group?.[0].ingest === item.ingest) group.push(item);
            else groups.push([item]);
          }
          if (!groups.length) groups.push([]);
          for (const [index, group] of groups.entries()) {
            const items: IngestItem[] = [];
            const cursors = [];
            for (const item of group) {
              const result = normalizeUsagePayload(item.payload, () => item.label);
              if (result.kind === 'event') items.push({ event: result.event, raw: result.raw });
              else if (result.kind === 'rejected') {
                status.rejected += 1;
                store.recordRejected(result.reason, result.raw);
              }
              if (item.cursor) cursors.push({ instance: item.instance, cursor: item.cursor });
            }
            const last = index === groups.length - 1;
            if (kind === 'replay' && last)
              cursors.push({ instance: body.instance, cursor: body.cursor });
            const gap = kind === 'replay' && last ? body.gap : undefined;
            const recovered =
              kind === 'replay' && last && body.complete ? body.instance : undefined;
            const result = store.insert(items, group[0]?.ingest ?? 3, {
              cursors,
              gap,
              recoveredInstance: recovered,
              replayInstance: kind === 'replay' ? body.instance : undefined,
            });
            status.inserted += result.inserted;
            status.duplicates += result.duplicates;
          }
          status.gaps = store.gapCount();
          if (kind === 'live') status.backlog -= body.length;
        } else if (kind === 'resume') {
          const heartbeat = store.getMeta(`heartbeat:${body.instance}`);
          const cursorAt = store.getMeta(`cursor-at:${body.instance}`);
          const recoveryFromMs = store.recoveryFromMs(body.instance);
          self.postMessage({
            id,
            ok: true,
            body: {
              ...status,
              resume: {
                cursor: store.getCursor(body.instance),
                ...(cursorAt === null ? {} : { cursorAtMs: Number(cursorAt) }),
                ...(recoveryFromMs === null ? {} : { recoveryFromMs }),
                heartbeat: heartbeat === null ? null : Number(heartbeat),
              },
            },
          });
          return;
        } else if (kind === 'recovery') {
          store.recordRecovery(body.gap, body.requireAnchor);
          status.gaps = store.gapCount();
        } else if (kind === 'gap') {
          store.recordGap(body);
          status.gaps += 1;
        } else if (kind === 'heartbeat') {
          store.setMeta(`heartbeat:${body.instance}`, String(body.atMs));
        }
        status.rawBufferFailures = store.rawBufferFailures;
      }
      reply();
    }).catch(() => {
      // An event DB failure is fatal to the bridge; it must stop collection instead of losing a batch.
      self.postMessage({ id, ok: false, body: { error: 'Usage writer job failed', fatal: true } });
    });
  };
}
