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
  event is priced as partial.

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
