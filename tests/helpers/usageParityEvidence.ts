// Reproduce committed plumbing evidence. No live DB/key/server is contacted.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parityServers } from './usageParityServers';
import { quietGate } from './usageParity';
import { runParity } from '../../scripts/usage-parity/run';
import { parseArgs } from '../../scripts/usage-parity';
import { openParityReader } from '../../scripts/usage-parity/events';
import { DUAL_RUN_START } from '../../scripts/usage-parity/matrix';
import {
  CPAMP_EVENT_COLUMNS,
  cpampPreconditions,
  mapCpampRow,
  type CpampSourceRow,
} from '../../server/usage/importCpamp';
import { UsageStore } from '../../server/usage/store';
import { createCpamp, cpampRow } from '../fixtures/cpampUsage';

export async function generateParityEvidence(directory: string) {
  for (const name of ['equal', 'known', 'unexplained'] as const) {
    const f = parityServers({
      d5: name === 'known',
      mutate: (r, backend) => {
        if (backend !== 'cpamp') return;
        if (name === 'known')
          r.requests.items.forEach((item) => {
            item.provider = 'synthetic-credential-snapshot-provider';
            item.trace_id = 'synthetic-header-trace';
          });
        if (name === 'unexplained') {
          r.summary.average_latency_ms!++;
          r.requests.has_more = false;
          r.requests.next_before_ms = null;
          r.requests.next_before_id = null;
        }
      },
    });
    try {
      const signal = new AbortController().signal;
      const report = await runParity(
        { ...f.options, output: join(directory, `synthetic-${name}`) },
        signal,
        { gate: quietGate(signal), nowMs: f.nowMs }
      );
      console.log(
        JSON.stringify({
          synthetic: true,
          name,
          status: report.status,
          response_counts: report.response_counts,
          counts: report.counts,
        })
      );
    } finally {
      f.close();
    }
  }
  const root = mkdtempSync('/dev/shm/prox-parity-evidence-events-');
  const sourcePath = join(root, 'cpamp.sqlite'),
    targetPath = join(root, 'prox.sqlite');
  const cpamp = createCpamp(sourcePath, 0);
  const start = DUAL_RUN_START + 300000;
  for (let i = 1; i <= 3; i++) cpamp.add(cpampRow(i, { timestamp_ms: start + i }));
  cpamp.db.exec('CREATE INDEX idx_usage_events_timestamp ON usage_events(timestamp_ms)');
  const source = openParityReader(sourcePath);
  const store = new UsageStore({ events: targetPath, raw: null });
  try {
    const rows = source
      .query<CpampSourceRow, []>(`SELECT ${CPAMP_EVENT_COLUMNS} FROM usage_events`)
      .all();
    const events = rows.map((r) => mapCpampRow(r, cpampPreconditions(), new Set())!);
    store.insert(
      events.slice(0, 2).map((event) => ({ event, raw: null })),
      0
    );
    store.insert(
      [
        {
          event: { ...events[0], executionId: 'synthetic-drained-during-cpamp-outage' },
          raw: null,
        },
      ],
      1
    );
    store.recordGap({
      instance: events[0].instance!,
      fromMs: start,
      toMs: start + 100,
      reason: 'subscription-dropped',
    });
    const outageFile = join(root, 'outages.json');
    writeFileSync(
      outageFile,
      JSON.stringify([
        {
          from_ms: start,
          to_ms: start + 100,
          instance: events[0].instance,
          reason: 'synthetic CPAMP outage fixture',
        },
      ])
    );
    const now = start + 86400000;
    const options = parseArgs(
      [
        '--from',
        new Date(start).toISOString(),
        '--to',
        new Date(start + 300000).toISOString(),
        '--level',
        'events',
        '--cpamp-db',
        sourcePath,
        '--prox-db',
        targetPath,
        '--cpamp-outages',
        outageFile,
        '--output',
        join(directory, 'synthetic-events'),
      ],
      now
    );
    const signal = new AbortController().signal;
    const report = await runParity(options, signal, { gate: quietGate(signal), nowMs: now });
    console.log(
      JSON.stringify({
        synthetic: true,
        name: 'events',
        status: report.status,
        events: report.events,
        counts: report.counts,
      })
    );
  } finally {
    source.close();
    store.close();
    cpamp.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (import.meta.main)
  await generateParityEvidence(resolve(Bun.argv[2] ?? 'docs/evidence/prox-usage-parity'));
