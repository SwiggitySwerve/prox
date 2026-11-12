# Usage collection, storage, pricing and analytics ownership

This package owns usage collection from the proxies, the event store, pricing and
the analytics calculations. It is the `prox-usage` service: its own process and
unit, not part of the history server.

- `prox-usage` is the only consumer of the proxies' usage stream and the only
  process that opens `usage.sqlite`. Everything else reads through its loopback
  HTTP API. The history server, the browser and the exporter never open the file.
- The thread that owns sockets makes no SQLite call. There is exactly one write
  connection, in the writer worker; every write is a job in its queue. Readers
  are read-only and bounded by the request deadline.
- An event's identity is its `execution_id`. Inserts are idempotent. Rows are
  never updated after insertion; a correction is a typed, tested migration.
- Tokens come from the proxy's canonical breakdown. No provider-specific
  inference is added here; a record without a complete breakdown is kept,
  flagged and priced as partial.
- Stored values never depend on the rate book. Prices are current configured
  rates applied at query time; the book file is the only source of prices; a
  missing rate is unknown, never zero.
- Percentiles are exact nearest rank over positive samples. No approximation is
  introduced without changing the contract.
- A response is computed in one read snapshot. Coverage states what is known:
  pruned ranges and recorded collection gaps make `raw_complete` false; retained
  events are not an ingress ledger; estimates are not bills.
- Stored and returned fields are an allowlist. Client keys are stored only as
  SHA-256; fail bodies, response headers and credential files are never stored.
  Account labels come from the proxies' credential listing through the
  management API, never from files on disk.
- Search is bounded by the requested range. A query with a search term never
  occupies the fast lane.
- A management authentication failure backs off for at least a minute; the
  collector must never cause an address ban.
- Tests and browser exercises use synthetic data only.

## Module layout

- `types.ts`, `normalize.ts` and `schema.ts` hold no SQLite import, so any thread
  may load them. `store.ts` is the only module that opens a database. Import it
  from the writer worker and the query workers only; a test asserts the first
  three stay free of it.
- Workers are threads (`new Worker`), decided by the P0 spike on the pinned Bun
  1.4.3: a read-only scan of a million rows and a concurrent writer left the main
  thread's 250 ms timer at most 19 ms late under full CPU and disk load, with no
  `SQLITE_BUSY`. Workers speak one message shape, `{id, kind, body}` in and
  `{id, ok, body}` out, so the same entry file also runs as a child process
  (`Bun.spawn` with IPC) if threads ever have to be abandoned.
- Every worker file is its own `bun build` entry point, and its path is resolved
  at run time beside the main bundle (`.ts` from source, `.js` from the bundle).
  `bun build` does not follow `new Worker(new URL('./x.worker.ts', import.meta.url))`:
  it leaves the `.ts` path in the output and the bundle fails at start.

## The store

- Two files. `usage.sqlite` holds events; `usage-raw.sqlite` is a 30-day buffer of
  sanitized payloads for re-deriving events, never read by analytics, and safe to
  delete while the service is stopped. Both are WAL with `synchronous=NORMAL`.
- `events` is clustered by `(ts_ms, seq)` and holds integers only; repeated
  strings live once in `dim`. `event_detail` holds identifiers, joined by `seq`.
  `execution_id` is unique there, and the insert is `ON CONFLICT DO NOTHING`: the
  first arrival of an execution stays, whichever way it arrived (`ingest`).
- `seq` is ingestion order from `meta.next_seq`. A duplicate consumes none.
- Schema changes are numbered, forward-only migrations (`USAGE_MIGRATIONS` in
  `schema.ts`), counted in `meta.schema_version` and run by the writer at start.
  The initial schema is migration 1. Append; never edit one that has shipped. A
  database newer than the build is refused. A migration that rewrites a table
  runs as a governed bulk job, not at start. The raw buffer has no migrations.
- Sessions live in `session`, one row per UUID, never in `dim`: there are
  hundreds of thousands a year and search scans `dim`. `derived` is 1 for a UUID
  of version 8, which the proxy derives itself (from context or a hash of the
  first messages), so a derived session can merge unrelated conversations and
  must be labelled, never attributed across clients. `parent_id` links a
  subagent's session to its parent; the first parent reported for a session
  stays. `event_detail` keeps what each event itself reported.
- `events.auth_index_id` is the proxy's credential index (`dim` kind
  `auth_index`), kept whatever the account label says: it is the only key that
  joins usage to quota.
- `usage_flags`: bit 0 usage presence reported, bits 1 to 6 the components the
  proxy observed (input, output, reasoning, cache read, cache creation, total),
  bit 7 the token columns come from a complete canonical breakdown, bit 8 the
  payload carried a `usage_fields` object (so "all false" differs from "absent").
- With bit 7 clear, the token columns hold the proxy's raw counters as reported:
  `input_total` and `input_uncached` both hold the reported input, and
  `input_total = input_uncached + cache_read + cache_write` does not hold. Such an
  event is priced as partial. Imported history is the exception to the raw-counter
  layout: with bit 7 clear it preserves CPAMP's persisted normalized columns,
  still priced as partial.

## The normalizer

`normalizeUsagePayload` is the one pure function from a payload
(`CLIProxyAPI/internal/redisqueue/plugin.go`, `queuedUsageDetail`) to a row.

- A complete breakdown means `accounting_version` 2, breakdown schema version 2,
  quality `complete`, no unclassified tokens, non-negative integers, and sums that
  add up. Anything else falls back to the raw counters.
- The model is the alias, else the upstream model, with a trailing reasoning
  suffix removed: `(none|auto|minimal|low|medium|high|xhigh|max|-1)` in any case,
  or a non-negative integer. The billing model is the upstream model, else that.
- The pricing tier: an explicit effective tier replaces the requested tier; then
  for Codex (recognized from executor, provider or auth type) the request wins
  over the response, and for every other provider the response wins.
- `latency_ms` is kept only when positive. `ttft_ms` is null when negative or when
  the method is `unavailable`; a zero is kept only for a method the proxy names.
- `ts_ms` is the proxy's RFC 3339 `timestamp` truncated to milliseconds.
- The path loses its query string before it is stored, because a query string can
  carry a client credential. The user agent and client address are reduced to one
  bounded line; the credential scrubber for returned text belongs to the query
  engine.
- The raw buffer keeps only allowlisted keys. `api_key`, `source`,
  `access_token_sha256`, `response_headers` and `fail.body` are removed; a key the
  normalizer does not know is dropped and counted in `payloads.dropped_keys`.
- A payload that is not a JSON object is counted in `rejects` without its text:
  text that cannot be allowlisted is never stored.

Regression coverage lives in `tests/proxUsageNormalize.test.ts` and
`tests/proxUsageStore.test.ts`, with synthetic payloads from
`tests/fixtures/usagePayloads.ts` shaped like the proxy's own plugin tests.

## Collection and writer queue

- `main.ts`, `collector.ts`, `resp.ts`, `labels.ts`, `status.ts` and `writer.ts`
  own sockets, source lifecycle, credential snapshots, HTTP and worker messaging.
  Their runtime import graph never reaches `bun:sqlite`; the service test walks
  that graph. The writer entry is resolved beside the running bundle at runtime.
- A source authenticates and waits for the `SUBSCRIBE usage` acknowledgement
  before draining the destructive HTTP queue. Both RESP and HTTP authentication
  failures block that source's management requests for at least 60 seconds.
- Shutdown keeps accepting messages until `UNSUBSCRIBE` acknowledges. Only then
  does it flush accepted batches and close the writer. Missing acknowledgements
  and event-store failures produce an unsuccessful exit, not a successful flush.
- The main thread dispatches at 100 payloads or 50 ms. Its backlog includes
  buffered payloads and every batch awaiting a worker acknowledgement. Above
  50,000 it drops all subscriptions, records gaps, and waits until at most 1,000
  remain before reconnecting. Another subscriber (including CPAMP) prevents the
  proxy retaining this traffic: the dual-run reconcile remains necessary.
- The worker serializes every write through `enqueueJob(kind, fn)`; `live` jobs
  precede waiting background jobs. P3 supplies bounded import, backup and prune
  chunks through that hook, including the roadmap's byte/IO governor. No bulk
  jobs or automatic raw-buffer pruning run in P2.
- Heartbeats commit every 10 seconds while subscribed, behind accepted events.
  Startup records the interval between a stale heartbeat and the start of the
  proxy's 3600-second retention window. A drop records the uncertain interval
  since the last socket activity; reconnect/stop records the subsequent outage
  as an adjacent gap. `missed` stays NULL: this protocol cannot count losses.
- Credential refreshes keep the last good snapshot; unknown indices trigger at
  most one refresh per 10 seconds. Each queued event carries its label snapshot
  so later credential changes cannot relabel an accepted event.
- An event commit and its optional raw-buffer write are separate transactions.
  A failed raw write is logged without payload/error text and increments
  `rawBufferFailures`. Committed events stay acknowledged; subsequent batches
  continue. A failed event commit stops collection and exits unsuccessfully.
- P2 serves only loopback `/healthz` and bearer-protected `/v1/status`. P5 adds
  query workers and analytics; E3 adds a separate metrics-only bridge listener.
  Neither analytics routing nor the history/exporter consumer changes in P2.
- Both usage entry points ship in the existing history image. Deployment hashes
  both bundles and restarts the separate usage unit only when that hash changes.
  Manifest or unit changes alone require an explicit operator restart.

Collector, writer and service regressions use the ephemeral in-process proxy in
`tests/helpers/usageFakeProxy.ts`, synthetic payloads, and small temporary files.

## Rate book and pricing

- `rates.ts` validates the version-1 JSON boundary and owns rate overrides,
  canonical revisions and the loader. All four rate fields are required; use
  `null` for unconfigured and `0` for explicitly free. Unconfigured tier fields
  inherit the base rate. Context thresholds must be distinct positive integers;
  service names match case-insensitively and cannot overlap between rows.
- `price_revision` hashes canonical JSON with sorted object keys after removing
  model `source` and `updated_at_ms`. It is specific to this book format, not
  CPAMP's Go serialization. Loader snapshots are immutable; each query uses one
  snapshot. Failed reads/validation retain the previous book and expose `error`.
- `pricing.ts` owns candidate resolution, estimate statuses/reasons, combining
  known subtotals, context-band selection and the catalog/observed rate inventory.
  The final service `names` entry is its inventory label; the CPAMP exporter
  writes `[mode, service_tier]` (deduplicated). All names price the same row.
- SQL aggregation must group by usage flags and record kind as well as model,
  tier and context band, so measured zero and unknown presence cannot be merged.
  Pass `contextThreshold: null` for the base band or the selected threshold for
  a context band. Never classify a sum as if it were one large request. An
  aggregate with multiple calls and configured context tiers must pass its band.
- Incomplete breakdowns (bit 7 clear) add `usage-components-unreported`; live
  counters remain raw and imported history preserves CPAMP's persisted columns.
  No provider cache inference, built-in prices, premiums, service multipliers or
  legacy cache rate is used. Missing cache-write rates
  use input; other missing components are dropped with CPAMP's exact reason.
- One-time migration: `bun scripts/usage-export-cpamp-rates.ts <book.json>
  [cpamp-usage.sqlite]`. It opens only the CPAMP source with `mode=ro`, read-only
  flags and `query_only=1`; only the three price tables and `api_key_aliases` are
  read. It refuses existing output files and also writes
  `<book.json>.client-aliases.json` containing `client_alias` rows for a later
  writer-worker import. Neither the Prox database nor configuration is updated.
  D5's two missing models are added with null rates and source `pending D5`;
  approved prices are required before deploying that book.

## Bulk jobs (import, reconcile, verify and backup)

`ioGovernor.ts` owns bulk IO admission and pacing. Share one `IoGovernor` in the
writer worker. `waitForQuietIo(signal)` admits work only below 5% `full avg10` IO
PSI. At or above 15%, recovery requires 30 continuous seconds below 5%. Missing
PSI fails closed. A pause longer than six hours invokes `reportLongPause` once
(or warns to stderr when no callback is supplied); it never overrides the wait.
`counters` exposes pause seconds, read bytes, written bytes and long-pause count.

After each chunk, call `reportBytes({read, written}, signal)`. Reads plus writes
are capped at 4,000,000 bytes/second by default (`bytesPerSecond` overrides it).
Work time counts against the chunk's pacing interval; unrelated idle time earns
no credit. Chunks are allowed to burst, but the next chunk waits out their byte
cost. Import jobs measure Linux `/proc/thread-self/io` syscall bytes, including
page-cache reads and WAL writes; source mmap is disabled so it cannot bypass the
counter. Chunk work is synchronous on the writer thread; no other job runs inside
the measured interval. Tests inject PSI, the clock and byte counters.

### P2 integration API

- `runCpampJob(store, cpampReader, {mode, governor, signal, betweenChunks})`, from
  `importCpamp.ts`: `mode` is `import`, `reconcile` or `verify`. The caller owns
  both handles and must close them. `store` is the writer's `UsageStore`;
  `cpampReader` is opened read-only through `store.ts`'s `openUsageReader` with
  `query_only=1` and `temp_store=MEMORY`. No raw payload buffer is needed.
- Worker integration is deliberately pending. Do **not** enqueue either whole
  job in P2's `WriterQueue`: its contract requires one bounded chunk per job.
  `betweenChunks` runs without a transaction, before IO admission; it alone is
  not a queue adapter. The direct job API currently serves tests and the bounded
  in-memory mapping check. Do not run two jobs with one governor concurrently.
- Import and reconcile keyset by source `id`, 1,000 rows per transaction. The
  store's `importChunk` commits inserts, deduplicated field conflicts and
  `import:cpamp:last_id` together. Existing events always win. Reconcile continues
  that same cursor. Re-running a completed import writes nothing.
- Verify writes nothing. Every mutating pass ends with a separate governed full
  verification up to the captured source maximum, including previously committed
  chunks after a restart. It matches source execution IDs, including live overlaps;
  target-only live events are outside this migration check. It compares all mapped
  fields and exact per-UTC-hour rows, failures, seven token sums, latency sum, and
  positive TTFT sum/count. Sums are BigInt internally and decimal strings in the
  report. A missing or duplicate identity prevents an exact verdict. The report
  counts invalid JSON, timestamps and tokens, incomplete/invalid canonical
  breakdowns and non-positive latency. Unmappable rows are skipped and reported;
  review the report before accepting a cursor. No invalid identity is fabricated.
- CPAMP's persisted accounting columns are copied. Metadata from `raw_json` is an
  explicit `json_extract` allowlist; headers, fail bodies and client keys are never
  selected. Metadata validation, model suffix handling, timing, presence, tiers
  and session UUID provenance reuse the live normalizer. A persisted token value
  differing from the validated canonical breakdown clears the complete flag.
  Sessions and credential indexes use the store's existing insert path.
- `maxRows` is diagnostic only: it limits each pass, and the verification report
  covers only that prefix. The final migration check must omit it. An import
  followed by verification reads that prefix twice; respect any diagnostic read
  limit across both passes.

Run the actual import only in a quiet window: outside 01:00–04:00 UTC and the
12:30 UTC daily fstrim. This module does not schedule jobs or enforce calendar
windows. The first successful off-pool backup is required before the real import;
that operational gate belongs to the coordinator, not these job functions.

### Backups

The backup job API is `new UsageBackup(config, {governor}).run(store, signal)`.
Future P2 integration must queue only its snapshot operation, with upload and
pacing outside the writer queue. `lastSuccessAtMs` starts at null and advances
only after all required uploads succeed. It is in-memory health state for later metrics, not a durable
backup manifest. Job modules open no databases or network listeners.

`loadBackupConfig(path?)` reads a JSON object from the supplied path (or
`PROX_USAGE_BACKUP_CONFIG`). Its fields are `endpoint`, `bucket`, `accessKeyId`,
`secretAccessKey`, optional `region` (default `us-east-1`), `sessionToken`, and
`tmpfsDir` (default `/dev/shm`). The corresponding `PROX_USAGE_BACKUP_ENDPOINT`,
`_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION`, `_SESSION_TOKEN` and
`_TMPFS_DIR` environment values override the file. Keep config files private;
secrets and signed URLs must never be logged. No real credentials ship here.

The backup refuses a directory that is not tmpfs, or less than twice the database's
WAL-inclusive logical size in free space. It VACUUMs into a private temporary
directory, then uploads 64 KiB chunks using a PUT signed by the pinned Bun 1.4.3
`S3Client`. Each chunk counts its tmpfs read plus network write and is paced
before sending, with backpressure and no redirect or automatic retry. Temp files
are deleted on success, failure and cancellation. **VACUUM is one indivisible
SQLite operation:** its reads cannot be chunked; admission is PSI-gated and its
measured bytes are charged afterward. It writes only to tmpfs. Revisit the
snapshot method and tmpfs headroom before the database reaches 2 GB.

Object keys are `usage/daily/usage-YYYYMMDD.sqlite` in UTC and, on Sundays,
`usage/weekly/usage-YYYYMMDD.sqlite`. Configure bucket lifecycle expiration at
14 days for the daily prefix and 56 days for the weekly prefix (eight weekly
copies). The client never lists, prunes or deletes objects. It backs up
`usage.sqlite`, including `client_alias`; the rate book remains a separate git
artifact and the raw buffer is excluded. P4/P2 must arrange rate-book distribution
alongside the backup; there is no rate-book table in the P1 schema.

The coordinator configures the off-pool target and records the quarterly restore
drill. This PR does not contact MinIO, run a real backup or perform a restore drill.


### Remaining worker integration

P2 landed while this change was being built. Its queue accepts one bounded
chunk per job, its RPC currently replies only with `WriterStatus`, and any RPC
failure stops collection. A correct adapter also needs cancellation so shutdown
cannot wait indefinitely behind PSI or an upload. Together this exceeds the
coordinator's roughly 150-line limit for wiring in this PR. No worker or admin
trigger is added here. The integration PR must:

1. Add a generic chunk scheduler to the job options. Keep PSI waits and byte
   sleeps outside `WriterQueue`, and recheck admission when a queued chunk
   starts. Queue each 1,000-row source read/transaction and verification read
   with `enqueueJob(kind, fn)`; queue only the snapshot for backups. Retain
   synchronous IO measurement inside each queued chunk so live writes are not
   charged to it. Upload chunks remain outside the queue.
2. Extend `writerProtocol.ts` with import/reconcile/verify/backup and cancellation
   requests and typed job reports/errors. Expose them through `UsageWriter`
   without making a rejected config/source/backup job fatal to live ingestion.
3. Have `writer.worker.ts` own a single active bulk orchestration, shared
   governor, read-only CPAMP handle, backup config and last-success state.
   Close the source in `finally`; cancel and settle active orchestration before
   closing the write connection. Live flush/shutdown must not wait six hours on
   a bulk job's pressure wait. No job/config/source handle belongs in `main.ts`.
4. Test real worker messages with synthetic CPAMP/fake S3, live commits during
   PSI and pacing waits, cancellation/shutdown, nonfatal bulk-job failures and
   the existing main-thread module-graph guard. Keep any later HTTP admin
   trigger loopback-only and bearer-protected; validate its inputs at the edge.
