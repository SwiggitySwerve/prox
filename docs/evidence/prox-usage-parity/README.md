# P6 parity harness

This directory contains synthetic plumbing evidence, not a live cutover verdict.
No live response pair or live event comparison was run for this PR. Neither
database was changed, and neither systemd template was installed or enabled.

The harness is `scripts/usage-parity.ts`. Run it from the repository root with
Bun 1.4.3. It writes a JSON report and a short Markdown report to this directory;
`--output` selects another prefix. Exit 0 means the selected comparisons have no
unexplained differences. Failure exits 1; interruption exits 130 with partial
evidence. A sampled run cannot establish the two clean nights/full matrices
required for cutover.

## Matrix source and accounting

The coordinator confirmed that the checked-in Go generators are authoritative.
They were read from `/home/swerve/Projects/CPA-Manager-Plus`, clean at commit
`52b12b45e010a766bd69ff55a55e566263d8bede`, under
`apps/manager-server/internal/service/monitoring/`:

- `prox_provider_rollup_test.go`, blob `2afc0df2b51c53f78baa4df9c2f201f92aaf0808`.
- `prox_search_test.go`, blob `0b739689d4f647356ea79aabaf0de4418127a1c4`.

| Mode | Plan count | Generated base queries | Pages and actual maximum | Reconciliation |
| --- | ---: | --- | --- | --- |
| Quick | 720 | 5 providers × 2 models × 3 outcomes × 2 searches × 4 rotating spans + 24 searches × 3 providers × 2 models × 3 outcomes × 1 rotating span = 240 + 432 = **672** | 672 × 2 pages = **1,344 pairs**; × 2 servers = **2,688 HTTP responses** | No source cases removed. Plan count cannot be reproduced from this version. |
| Full | 22,464 | 5 × 2 × 3 × 2 × 12 spans + 24 × 3 × 2 × 3 × 12 spans = 720 + 5,184 = **5,904** | 5,904 × 2 pages = **11,808 pairs**; × 2 servers = **23,616 HTTP responses** | No source cases removed. Plan count cannot be reproduced from this version. |

The plan calls its figures responses; this table distinguishes base queries,
pairs and HTTP responses. No historical version explaining 720/22,464 was identified;
these are not percentage reductions in the same unit. UTC mapping removes zero
query cases. Granularity/time-zone slots rotate within existing cases and are
not independent factors. Page 2 is an addition to the Go generators.

| Axis | CPAMP rollup generator | CPAMP search generator | Harness |
| --- | --- | --- | --- |
| Ranges | 1, 6, 24, 168, 720, 744 hours × aligned/unaligned = 12; quick chooses 4 with `(floor(span/2)+combination)%3 == 0` | Same 12; quick chooses `combination%12` | Identical selections; requested-window clipping counted separately |
| Buckets/granularities | Hour/day in 8 rotating view slots, 4/4 | Hour/day in 5 rotating slots, 3/2 | Same slot/granularity rotation; factor 1 |
| Outcomes | 3: all, success, failed | Same 3 | Same 3 |
| Providers | 5: empty, claude, CODEX, gemini, nobody | 3: empty, claude, CODEX | Same 5 / 3 |
| Models | 2: empty, shared-model | Same 2 | Same 2 |
| Search terms | 2: empty, needle | 24 | Same 2 / 24 slots; three fixture-only terms replaced as below |
| Time zones | 5 distinct zones across 8 view slots | 5 distinct zones across 5 view slots | Every slot mapped to UTC; **0 cases dropped**, factor 1 |
| Pages | 1 | 1 | First page plus second when both have it; each backend's own cursor |

The rollup catalog entry (`instance`, `Instance`, `claude`, `claude-only`) is also
preserved. Search slots targeting CPAMP-only project/failure data are replaced:
`acct-needle` → `session-needle`, `proj-needle ` → `trace-needle `, and `team ` →
`priority`. All 24 search slots remain, including LIKE wildcards, quotes, Unicode,
case variants and no-match terms. These are column probes; live data need not
contain every fixture term.

A second page present on only one backend is an unexplained paging difference.
If neither has one, the report counts it as absent on both. `--limit` counts
pairs including page 2; `--sample` selects evenly spaced base cases. Reports
include compared/equal/unexplained pair counts, known pair counts per rule
(which can overlap), and separate counts of individual differing fields/events.

## Rules checked

Event reads start no earlier than `2026-11-12T21:16:05Z`. They force CPAMP's
`idx_usage_events_timestamp` in windows of at most five minutes, with keyset
pages of at most 1,000 rows. Both handles use `file:...?mode=ro`, read-only flags,
`PRAGMA query_only=1`, memory temp storage and disabled mmap. There is no import,
reconcile, checkpoint, backup or update operation in this harness.

The event projection compares timestamp, provider, model/requested/billing
models, tier, failure/status, latency, TTFT, seven token counters, flags, record
kind, account, account label and client-key hash. CPAMP metadata/account mapping
uses the existing import owner: account snapshot falls back to label, then auth
index; only a validated SHA-256 hash is used. All subscribed Prox-only events
fail. Extra imported/replayed events are counted outside that reverse cohort.
No credential-label timing exception is assumed.

Explicit counted rules:

- `ingest-gap`: missing Prox event whose instance/time falls in a stored gap.
  The interval and reason are retained even if it explains no missing event.
- `drained-during-cpamp-outage`: a Prox-only `ingest=1` event requires a supplied
  CPAMP outage with the same instance and time. Without evidence it fails.
- `detail-provider`: only `requests.items[].provider`, payload versus credential
  snapshot, as documented by P5 PR #71. Aggregate/filter differences still fail.
- `detail-trace`: only `requests.items[].trace_id`, payload versus response-header
  provenance from the same P5 documentation. Other detail fields remain exact.
- `d5-pricing`: only cost/rate differences reproduced by two local read-only
  `queryAnalytics` replays over Prox: the approved deployed rate book, then that
  same book with only `claude-fable-5-2` and `gpt-6.1-terra` removed. Both observed
  values must match their replay. This prevents blanket exemptions for totals
  that contain a newly priced model. Replays also pass through the IO gate.

Response normalization removes only `generated_at_ms`, `coverage.price_revision`,
request item `id`, and `requests.next_before_id`; permits item reordering only
inside equal-timestamp groups; and allows 1e-9 relative error only at `cost.usd`
(no absolute epsilon at zero). Every integer, p95, average, reason and coverage
field stays exact. Known differences remain in the report with both values.

## Running it

```sh
# Nightly window, event comparison plus the source quick matrix.
ionice -c3 nice -n10 bun scripts/usage-parity.ts --previous-utc-day

# Operator-selected smoke: at most 20 response pairs, no event scan.
# Replace timestamps with a settled window; after 21:20 UTC on the dual-run day.
ionice -c3 nice -n10 bun scripts/usage-parity.ts \
  --from 2026-11-12T21:20:00Z --to 2026-11-12T21:40:00Z \
  --level responses --limit 20 --sample 10

# Full source coverage: include the earliest ALIGNED 31-day start.
# Supply settled FROM/TO values and run only when the coordinator schedules it.
ionice -c3 nice -n10 bun scripts/usage-parity.ts \
  --from "$PARITY_FROM" --to "$PARITY_TO" --matrix full
```

Each query waits for `/proc/pressure/io` **full avg10 < 5** and for a default
2-second gap after the previous query completes. There is one operation in
flight, no automatic expensive retry, and DB reads are additionally paced by the
shared 4 MB/s byte governor. Missing PSI fails closed. `--min-gap-ms` is configurable;
the synthetic fixtures use zero and fake PSI. Cancellation interrupts pressure,
pacing and fetch waits. HTTP queries have a 30-second deadline and do not follow
redirects. Endpoints must be loopback HTTP. Key files are read inside the process
and never enter reports, errors or command arguments.

Default DBs are `~/.local/share/cpa-manager-plus/usage.sqlite` and
`~/.local/share/prox-usage/usage.sqlite`; bearer files are
`~/.config/prox/cpa-admin-key` and
`~/.config/cli-proxy-rerank/management-key`. The default D5 witness book is
`~/.config/prox/usage-rates.json`; use `--rate-book` for another deployed path.
`--cpamp-outages` accepts a JSON array of
`{from_ms,to_ms,instance,reason}`; an interval needs an operational reason, not a
guessed gap. All paths/endpoints have documented `--help` overrides.

`deploy/prox-usage-parity.service` and `.timer` are uninstalled templates. The
service assumes `%h/src/prox` and Bun on its configured PATH; the coordinator
must review those paths before installing. It invokes `ionice -c3 nice -n10`,
quick plus events for the previous UTC day at **04:30 UTC**. `Persistent=false`
avoids a catch-up run at login during the forbidden period. There is no install,
enable or start action in this PR. This read-only timer does not perform the
separate reconcile/import jobs needed by plan step C.

## Verification

Focused tests use only temporary `/dev/shm` databases and ephemeral fake HTTP
servers, then delete them. They cover every event field (including exporter
labels), 1,001 tied timestamps across a keyset boundary, read-only enforcement,
both event directions, bounded index enforcement, each exception rule, second
page disagreement and backend-specific cursors, exact normalization, IO gating,
serialization, cancellation, failed responses, private credentials and CLI/unit
contracts. The committed JSON/Markdown examples below are generated by these
same harness functions; the server calculations are synthetic plumbing checks,
not an independent validation of CPAMP arithmetic.

| Committed synthetic artifact | Compared / equal pairs | Known rules | Unexplained | Expected result |
| --- | --- | --- | ---: | --- |
| `synthetic-equal.{json,md}` | 2 / 2 | None | 0 | Pass |
| `synthetic-known.{json,md}` | 2 / 0 | 2 pairs each for D5, provider and trace; 86 D5 fields, 6 provider fields, 6 trace fields | 0 | Pass with counted exceptions |
| `synthetic-unexplained.{json,md}` | 1 / 0 | None | 1 pair / 4 fields, including one-sided page 2 | Fail, intentionally injected |
| `synthetic-events.{json,md}` | 3 source rows / 3 target rows; 2 matched | 1 ingest-gap event and 1 documented drain event | 0 | Pass with counted exceptions |

The helpers use an injected clock and fake PSI. Reproduce the artifacts with:

```sh
ionice -c3 nice -n10 bun tests/helpers/usageParityEvidence.ts
```

Final checks used Bun **1.4.3** (`c6da4a4d3`). The existing locked dependencies
were reused via a symlink to `/dev/shm/prox-rollup-deps-yskids/node_modules`, after
confirming the lockfiles matched; no install or deletion was performed.

- Focused `bun test tests/proxUsageParity{Compare,Io,Events,Runner}.test.ts`:
  **26 passed, 0 failed**, 6,047 assertions.
- One `ionice -c3 nice -n10 env PATH=/dev/shm/prox-bun-1.4.3/bun-linux-x64:$PATH bun run verify`:
  **3,096 tests passed, 0 failed** across 269 files; lint had 0 errors;
  TypeScript, Vite single-file build, history server and all usage-worker bundles passed.
- That verify run reported eight lint warnings: six existing React Refresh
  warnings and two new unused bindings. The two bindings were then removed
  without changing the comparison. Focused tests, standalone TypeScript and
  changed-file ESLint were rerun successfully; changed-file lint has no warnings.
  The full verify command was run once, as requested.
- Standalone TypeScript also covers the CLI, script modules, four new test
  suites and the evidence generator, which are outside the main application
  tsconfig. Command: `bun x --no-install tsc --ignoreConfig --noEmit --target
  ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck
  --types bun scripts/usage-parity.ts tests/proxUsageParity*.test.ts
  tests/helpers/usageParityEvidence.ts` (prefixed with `ionice -c3 nice -n10`).
- A separate real CLI process against ephemeral fake servers received SIGINT:
  **exit 130**, `status=aborted`, partial report written. IO full avg10 was 2.81;
  the temporary script, databases and keys were deleted. An earlier manual
  preflight stopped before any query because PSI was at least 5.
- `git diff --check` passed. No UI route changed, so browser checks do not apply.
No browser route changed. Live smoke, full matrix, two-night evidence and unit
installation remain for the coordinator.
