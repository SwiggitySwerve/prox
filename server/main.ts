import { createHandler } from './app';
import { QuotaStore } from './quota/store';
import { QuotaCollector } from './quota/collector';

const keyFile = process.env.PROX_MANAGEMENT_KEY_FILE ?? '/run/secrets/proxy-management-key';
const store = new QuotaStore(process.env.PROX_DB_PATH ?? '/data/quota.sqlite');
const collector = new QuotaCollector(store, { keyFile });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18319,
  fetch: createHandler({ store, collector, keyFile }),
});
collector.start();
console.log('Prox quota history listening on loopback port 18319');
const shutdown = () => {
  collector.stop();
  void server.stop(true);
  store.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
