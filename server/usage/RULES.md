# Usage collection, storage, pricing and analytics ownership

This package owns usage collection from the proxies, the event store, pricing and
the analytics calculations. It is the `prox-usage` service: its own process and
unit, not part of the history server.

- `prox-usage` is the only consumer of the proxies' usage stream and the only
  live process that opens `usage.sqlite`. Other services read through its loopback
  HTTP API. The offline operator parity reader is the exception documented below.
  The history server, the browser and the exporter never open the file.
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
The severe-pressure latch and outstanding byte deadline belong to the governor
instance and survive cancellation. The quiet recovery interval restarts whenever
monitoring exits: a later job must pay remaining byte debt and observe a fresh,
continuous quiet recovery before admission.

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
  chunks after a restart. It matches source execution IDs, including live overlaps,
  and independently keyset-scans the target table in bounded pages. Every imported
  target event counts, including extra hours or executions absent from CPAMP;
  `targetOnlyImported` and hourly totals make those extras fail `exact`. Unmatched
  subscribed/drained traffic remains excluded. It compares all mapped
  fields and exact per-UTC-hour rows, failures, seven token sums, latency sum, and
  positive TTFT sum/count. Sums are BigInt internally and decimal strings in the
  report. A missing or duplicate identity prevents an exact verdict. The report
  counts invalid JSON, timestamps and tokens, incomplete/invalid canonical
  breakdowns and non-positive latency. Unmappable rows are skipped and reported;
  review the report before accepting a cursor. No invalid identity is fabricated.
- `cpampRollupCheck.ts` adds the independent level-1 check against CPAMP's own
  `usage_pricing_hourly_provider_rollups_v1`. Its contract comes from CPAMP's
  `internal/repository/usagepricing/repository.go` (`upsertHourlyTableBatch`,
  `CatchUp`, `LoadHourlyRowsTx`) and the live schema, inspected read-only. It sums
  all provider/outcome/model/tier groups for the active `structure_revision`.
  Counters are calls, normalized total input, total output, reasoning, cache read,
  cache creation and total tokens. Cache read includes the rollup's compatible
  legacy `cached_tokens` plus `cache_read_tokens`, matching CPAMP's normalization.
  Uncached input has no independent rollup column; it is still checked against
  raw source rows. SQLite sums are returned as decimal strings to preserve exact
  integers above JavaScript's safe range.
- Rollup metadata, bucket pages and each hour's read snapshot all pass through
  the governor. Candidate hours also include rollup-only buckets, so a whole
  hour missing from both raw stores cannot silently pass. Compare only closed
  hours as of the job's captured wall clock (`nowMs` can be injected), schema 1,
  the same active revision, ready/catching-up state without an error, and buckets
  within the recorded range. The covered event ID must reach that hour's greatest
  source ID and must not exceed the source maximum captured by this job. Using
  IDs rather than a timestamp watermark handles late arrivals into older hours.
  Deleted-raw archive markers also make an hour uncovered: a rebuilt cache can
  include retained history no longer in the raw source table.
- `verification.rollups` reports `hours`, `mismatches` and `uncovered` separately,
  with a reason for each uncovered hour (missing tables/state, rebuild/error,
  revision changes, lag/ahead, open or archived hours and limited source passes).
  A rollup mismatch makes overall `verification.exact` false. Uncovered hours
  are not mismatches; `rollups.complete` means all candidate hours were covered,
  and accepting the independent check requires both complete coverage and no
  mismatches. Diagnostic `maxRows` passes never claim complete rollup coverage.
- CPAMP's persisted accounting columns are copied. Metadata from `raw_json` is an
  explicit `json_extract` allowlist; headers, fail bodies and client keys are never
  selected. Metadata validation, model suffix handling, timing, presence, tiers
  and session UUID provenance reuse the live normalizer. A persisted token value
  differing from the validated canonical breakdown clears the complete flag.
  Sessions and credential indexes use the store's existing insert path.
- `maxRows` is diagnostic only: it limits each pass, and the verification report
  covers only that prefix. Target accounting includes only the verified execution
  IDs, even when later imported events share their hour. Unlimited runs retain
  the independent target cohort scan and assertions for extra imported rows.
  The final migration check must omit it. An import followed by verification reads
  that prefix twice; respect any diagnostic read limit across both passes.

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

## Analytics queries

- `validate.ts` owns the strict `AnalyticsQuery` plus catalog boundary (one JSON
  value, no unknown fields, CPAMP byte/range/cursor bounds); only UTC is accepted.
  `handler.ts` authenticates both POST paths with the shared management bearer
  check, bounds streamed JSON to 1 MiB, and never imports a SQLite runtime module.
- `main.ts` mounts `/v1/analytics` and the temporary
  `/v0/management/monitoring/prox-analytics` alias alongside health/status. Rates
  come from `PROX_USAGE_RATES_PATH` (default `/data/usage-rates.json`). A missing
  initial book produces unpriced estimates and a coverage limitation; a failed
  reload keeps the last good book. The mount and approved rate file are deployment
  responsibilities; queries never update the book.
- `lanes.ts` has independent FIFO fast/search lanes, one active query and eight
  waiting in each. Overflow is 503. A 30-second deadline includes body reading,
  admission and execution; expiry is 504, client cancellation 499. Cancellation
  terminates the active worker, releasing its SQLite snapshot, before replacing
  it. Idle workers are reused; close/error listeners stay attached for the worker's
  lifetime, so an idle exit invalidates the cache. Shutdown rejects admission and
  terminates both.
- `query.worker.ts` opens its read-only connection through `store.ts`, performs
  the entire response in one deferred read transaction, serializes the response
  there and closes the connection. It uses the standard `{id, kind, body}` /
  `{id, ok, body}` RPC and also accepts child-process IPC. Its bundle is a separate
  `build:usage` entry beside `main.js` and `writer.worker.js`.
- `analytics.ts` groups by UTC bucket, provider, all three pricing candidates,
  tier, per-event context band, usage flags, record kind and outcome. The current
  book snapshot generates nested SQL CASE expressions over dictionary ids:
  billing, canonical, then requested candidate; thresholds descending, strictly
  exceeded; a configured base-only candidate stops fallback. No stored price
  table or index exists. SQL sums are priced with explicit bands and the P4
  pricing owner. All response sections use the same book/revision and snapshot.
- `analyticsPricing.ts` folds the unchanged SQL rows into CPAMP's pricing keys:
  `(model, billing model, resolved pricing model, context band, tier)`, adding bucket
  for timeline or provider for provider-specific stats. This folds across the
  SQL-only metadata/outcome keys for pricing; retained-event metrics still use all
  SQL rows. Summary stats sort by calls descending then `pricingRowLess` (model,
  billing model, pricing model, tier, band); model views inherit that order.
  Timeline sorts by bucket then `pricingRowLess`. Providers reuse global stats
  when each model has one provider; otherwise they follow the provider query's
  calls-descending order, with ties in its SQL key order (band before tier).
- `pricing.ts` exposes separate aggregate/request estimate boundaries over the
  shared money calculation. CPAMP aggregate tokens have no event metadata:
  presence is always unknown, component-reporting flags do not add request-only
  reasons, and only aggregate costs carry call counts. `parity.ts` adds the legacy
  reason after the aggregate's pricing reasons. Request costs keep event presence
  and component limitations, but no legacy-kind reason or call counts.
- Known supplementary rows are excluded from counts, pricing, latency, selectors
  and request detail, as CPAMP does. Selectors preserve the range/search while
  ignoring the provider, model and outcome filters. The page cursor changes only
  detail, never whole-scope totals.
- `latency.ts` selects exact positive-sample nearest ranks in typed arrays for
  the range, bucket, model and provider. Zero TTFT remains visible in detail but
  does not enter percentile samples. Average latency uses positive measurements.
- `search.ts` filters the time-clustered events after matching dictionary values;
  identifier detail is looked up only for events in that range. Long identifiers
  additionally try indexed exact execution/request/session matches. Substring
  fallback remains, including CPAMP's SQL LIKE wildcards, ASCII SQL lower(), and
  Unicode-lowercased query. It adds no search index or persisted projection.
- The inspector is an explicit allowlist. Token zero is visible only when its
  presence/component flags report it; positive counters stay visible. User agents
  pass `credentialText.ts`, a port of CPAMP's credential-text scrubber; path queries
  are removed again at serialization. Error summaries contain only the safe code
  or `Execution failed`. No key/hash or fail body is returned.
- `parity.ts` contains exactly the two P10 compatibility oddities: the legacy
  record-kind reason on every nonempty aggregate estimate and source attribution
  based on the current page. Coverage otherwise uses range-wide retention/gaps,
  import provenance, rate-book state and unknown providers, without claiming the
  event stream is an ingress ledger.
- Provider/trace provenance is limited by P1: `provider` and `trace_id` are the
  stored payload fields. CPAMP detail uses credential-provider snapshot and
  response-header trace id. Neither is inferred from another field. P6 must check
  these against imported/live rows; the response schema remains version 1.

Regression tests cover snapshot isolation, SQL pricing bands, null measurements,
search, coverage, worker IPC, bearer routing, bounded lanes, cancellation and a
main-thread graph free of SQLite. `scripts/usage-query-benchmark.ts` creates and
removes its 960,000-row synthetic store entirely in `/dev/shm`, using the P1 store
API, and records 50 warm worker responses per view while inserting synthetic
traffic. Run it with `ionice -c3 nice -n10` after IO `full avg10` drops below 5.
The live performance/parity gate is a separate deployment responsibility; a
30-day p95 above 1 s requires P5b before P6, per the plan.

## Offline parity evidence

`scripts/usage-parity.ts` is the operator-only read exception during the dual run.
It opens CPAMP and Prox with SQLite URI `mode=ro`, read-only flags and
`query_only=1`; it never imports/reconciles, writes events or joins either server's
runtime graph. CPAMP reads force `idx_usage_events_timestamp`, use five-minute
windows and 1,000-row keyset pages. `importCpamp.ts` exports its allowlisted
`CPAMP_EVENT_COLUMNS`, `mapCpampRow` and `cpampPreconditions` for this reader;
there is one CPAMP accounting/metadata mapping for import and parity.

The harness compares the seven token fields and the event identity, timing,
models, provider, tier, failure, status, flags and record kind, plus exporter
account, account-label and client-key-hash dimensions. The import owner's account
fallback (snapshot, then label, then credential index) still applies. No label
snapshot timing exception is authorized by this harness. A missing Prox event is
explained only by a matching instance/time in `ingest_gaps`; a Prox-only drained
event needs an explicit, documented CPAMP outage interval. Subscribed extras fail.

All operations share the existing IO governor and one serial query gate, with a
2-second default minimum gap after completion, cancellable PSI waits, measured
DB-byte pacing and a nonzero exit on unexplained differences, failure or abort.
There are no retries of expensive queries. The only response normalization is
plan §3.3's four volatile fields, relative `cost.usd` tolerance and ordering inside
equal-timestamp runs. Provider and trace provenance differences apply only to
request-detail fields and are counted. A D5 price exception needs two read-only
replays through `queryAnalytics`: the approved deployed book must reproduce the
Prox value, and removing only the two D5 models must reproduce CPAMP's value.
Other differences, including coverage and one-sided paging, fail the run.

The matrix is ported from CPAMP commit `52b12b45e010a766bd69ff55a55e566263d8bede`.
Its current source has 672 quick / 5,904 full base queries, with coupled view
rotation rather than extra time-zone/granularity factors. All view slots are kept
and mapped to UTC. Each backend supplies its own second-page cursor. Reports
reconcile the stale plan counts, expose each axis and window clipping, and retain
both values for every difference. The disabled user timer template runs quick
plus events for the previous UTC day at 04:30 UTC; installation and the two-night
cutover decision belong to the coordinator.
