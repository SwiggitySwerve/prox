// prox-usage owns sockets and HTTP here; its worker owns every SQLite call.
import { loadSourceManifest } from '../providerSources/config';
import { UsageCollector } from './collector';
import { UsageWriter } from './writer';
import { createUsageStatusHandler } from './status';
import { startEventLoopLagProbe } from '../eventLoopLag';

const { manifest } = loadSourceManifest(
  process.env.PROX_SOURCE_MANIFEST ??
    new URL('../../deploy/provider-sources.json', import.meta.url).pathname
);
const writer = new UsageWriter();
await writer.init(
  {
    events: process.env.PROX_USAGE_DB_PATH ?? '/data/usage.sqlite',
    raw: process.env.PROX_USAGE_RAW_PATH ?? '/data/usage-raw.sqlite',
  },
  manifest.sources.map((source) => source.instanceId)
);
let healthy = true;
const collectors = manifest.sources.map((source) => new UsageCollector(source, writer));
writer.onOverflow = () => collectors.forEach((collector) => collector.overflow());
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18320,
  fetch: createUsageStatusHandler({
    keyFile: manifest.history.managementKeyFile,
    sources: () => collectors.map((collector) => collector.status),
    writer: () => writer.status,
    jobs: writer,
    healthy: () => healthy,
  }),
});
let closing: Promise<void> | null = null;
const shutdown = (): Promise<void> => {
  if (closing) return closing;
  healthy = false;
  closing = (async () => {
    const stops = await Promise.allSettled(collectors.map((collector) => collector.stop()));
    try {
      await writer.close();
    } finally {
      await server.stop(true);
    }
    if (stops.some((stop) => stop.status === 'rejected')) {
      throw new Error('Usage unsubscribe did not acknowledge; final events were flushed');
    }
  })();
  return closing;
};
const exit = () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
writer.onFailure = exit;
process.once('SIGTERM', exit);
process.once('SIGINT', exit);
collectors.forEach((collector) => collector.start());
startEventLoopLagProbe();
console.log('Prox usage listening on loopback port 18320');
