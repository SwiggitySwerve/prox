# P5b hourly-rollup evidence

Measured with Bun 1.4.3 on 2026-11-12. No live database, service, unit or container was changed.
P5 and the subsequent manual-job/deployment wiring are merged from `origin/main`.

**The final synthetic 30-day hourly budget fails.** Its p95 is 1,031.383 ms against
<1,000 ms. The daily and 24-hour budgets pass. The real imported-history gate was
then measured on a copy of the live database and **passes**; see
[Real-data measurement](#real-data-measurement-2026-11-13) below.

## Synthetic budget

Command (IO `full avg10=1.23`, below 5, immediately before this run):

```sh
ionice -c3 nice -n10 env PATH=/dev/shm/prox-bun-1.4.3/bun-linux-x64:$PATH bun scripts/usage-query-benchmark.ts
```

| Range and buckets | p50 | p95 | Maximum | Budget | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 24 hours, hourly | 37.389 ms | 43.405 ms | 47.870 ms | <150 ms | PASS |
| 30 days, daily | 612.966 ms | 642.086 ms | 648.753 ms | <1000 ms | PASS |
| 30 days, hourly | 967.140 ms | 1031.383 ms | 1086.308 ms | <1000 ms | FAIL |

The final run output is [benchmark.jsonl](benchmark.jsonl). Exit status was 1,
because the script now enforces the p95 budgets. Three warmups were excluded
from each view; p50 is sorted run 25, p95 run 48, and maximum run 50. There is no
response cache. Timings include handler admission, worker execution, JSON
serialization and response-body consumption.

The fixture preserves P5’s 960,000 events (32,000/day for 30 days), 40 models,
two providers, six accounts, five clients, independent band/tier variation,
mixed outcomes, and absent TTFT. Its window keeps P5’s 21:20 UTC day/hour phase,
anchored in the past so closed hours can be rebuilt. Both boundary hours remain
partial raw reads. An earlier fully aligned-hour trial had hourly p95 996.324 ms;
it is superseded by the final run above, not used to claim the budget passes.

Construction and measurements used only a uniquely named `/dev/shm` directory.
The store, WAL/SHM, write probe and synthetic key were removed in `finally`.
Concurrent synthetic ingestion at four events/second added 342 events across
all views and kept the final hour dirty. This is a WAL concurrency check on
tmpfs; it does not measure production disk latency. No local build or test ran
concurrently with the budget measurement. Other host activity was uncontrolled.

## Exact read rules

- Clean, closed, wholly included hours with the current model/threshold layout
  use integer rollup sums and exact positive signed-int32 timing samples.
  Dirty, missing, open, partial, incompatible or unsupported hours read events.
- Full raw SQL group keys are retained, including requested/billing/model,
  provider, band, tier, flags, kind and outcome. Groups merge before the common
  P5 pricing projections, preserving floats, statuses and ordered reason arrays.
- Coverage retains all-event import/provider facts, including supplementary
  events. Request detail stays raw. A model/provider/outcome filter or search
  forces the entire response to raw.
- The authenticated analytics POST accepts `"debug_force_raw": true`. It
  changes no response field and lets P6 measure the raw path on the same store.
- Layout hashes cover model membership and context thresholds. Rate-only edits
  reuse rollups and apply the new prices immediately. Timings beyond signed
  int32 leave the entire hour raw rather than wrapping.

## Backfill and verification

Automatic maintenance runs one hour per `runIoChunk` / `enqueueJob` call through
`UsageBulkJobs`, sharing its one governor with manual jobs: 4,000,000 bytes/s by
default, PSI admission below 5%, severe-pressure recovery, and byte accounting
on failed chunks too. Waits remain outside the live-first queue. A one-second
yield and at most one pending maintenance operation prevent a post-import
burst. Shutdown aborts maintenance rather than draining history. Both live
`insert` and P3 `importChunk` invalidate hours in their event transaction.

Migration 2 only creates tables. Old hours are found by a persisted cursor and
primary-key seek, one hour at a time. Dirty hours and layout mismatches rebuild
whole; no sums increment. Readers remain correct during an incomplete backfill,
but such views may retain raw-path latency.

- Full `bun run verify`, once after integrating `main` through `7741214b`:
  **3,103 passed, 0 failed**, 267 files, 29,866 assertions. Lint: 0 errors, six
  existing React Refresh warnings. TypeScript, manifest check, single-file Vite
  output, history bundle and all usage worker bundles passed. Vite emitted its
  existing native-config-loader warning. Afterward only the benchmark fixture
  timestamp/probe alignment and evidence files changed; application code stayed fixed.
- Command: `ionice -c3 nice -n10 env PATH=/dev/shm/prox-bun-1.4.3/bun-linux-x64:$PATH
  TMPDIR=/dev/shm/prox-rollup-verify-tmp bun run verify`. Dependencies, temporary
  test files and generated build output were on tmpfs; `node_modules` was kept.
- Latest focused writer/jobs/governor/service/rollup run: 50 passed, 0 failed.
  The full suite includes exact whole-response comparison on four seeded stores,
  imported/dirty/open/partial hours, mixed bands/tiers/flags/kinds, pagination,
  arbitrary int32 bytes, layout changes, rollback and 3,000 imported hours.
- Worker regression uses synthetic host-pressure input and the actual shared
  governor/runtime. It checks rebuilds, live commits while maintenance is paused
  by PSI, and prompt shutdown. P3’s manual-job regressions remain intact. Its
  read-only verification assertion ignores unrelated derived-cache maintenance
  while checking every retained event/provenance table and non-rollup meta value.
- The initial extraction had byte-identical hourly/daily response dumps on 200
  mixed events. Pricing changes also compared 10,000 mixed estimator documents
  and 10,000 per-view projection rows against their pre-change implementations;
  all outputs matched byte for byte. Permanent tests cover prepared schedules
  across repeated bands/tiers and a changed book.

`src/domain/analytics/types.ts` and deployment files have no diff from main.
No browser exercise was needed for this backend-only change. No live CPAMP
response matrix, import, deployment, runtime log baseline or real-store budget
was run. Post-merge/live health remains unverified. The coordinator owns those
checks after the real history import.

## Profile and rebuild write cost

A separate `--profile` run on the same fixture is recorded in
[profile.jsonl](profile.jsonl). This is one direct diagnostic response, excluding
handler/RPC/serialization; it is not another p95 measurement. Major phases:

| 30-day hourly phase | Time |
| --- | ---: |
| Load integer rollup rows | 237.019 ms |
| Read and merge exact sample blobs | 299.213 ms |
| Partial/dirty raw spans and coverage | 1.025 ms |
| Order/merge aggregate groups | 26.272 ms |
| Exact nearest-rank selection | 44.148 ms |
| Build common pricing projections | 247.352 ms |
| Sort/price timeline projections | 112.331 ms |

The fixture builds 721 UTC hours (two partial range boundaries), 266,675 rollup
rows and 7,330,596 timing-sample bytes. Numeric row transfer, sample handling and
pricing preparation still consume most of a second. The synthetic hourly p95
remains over budget; no approximation or weaker response comparison was used
for a faster result.

The write probe in the profile run seeds one complete closed UTC hour with
1,334 events from the same generator, closes/reopens the store to checkpoint
seed writes, builds the hour, inserts one late imported event, and rebuilds it
whole. It uses a separate tmpfs database and measures WAL growth around each
rebuild, excluding the insertion itself:

| Operation | Rollup rows | Sample bytes | WAL bytes written | WAL bytes / row |
| --- | ---: | ---: | ---: | ---: |
| Initial build | 368 | 10,208 | 53,592 | 145.630 |
| Whole-hour replacement | 368 | 10,216 | 53,560 | 145.543 |

The initial write includes the 32-byte WAL header. Replacement writes 13 WAL
frames (4,096-byte pages plus 24 bytes/frame): about 52.3 KiB for this hour.
Checkpointing those pages can write another 53,248 bytes, for roughly 290
logical bytes per row combined. That checkpoint figure is an estimate from
frame count, not measured ZFS write amplification. Mirroring, compression and
copy-on-write costs were not measured. The governor charges actual syscall IO
for production chunks; the one-second yield provides additional pacing.

## Coordinator measurement

After the real CPAMP history import, allow governed hour rebuilds to complete
for the intended fixed window. Send the same authenticated `/v1/analytics`
query with `debug_force_raw: true` and without it. The default response may
still use raw spans while backfill is incomplete; do not interpret that as a
clean-rollup measurement. Repeat the 50-warm-run real-store gate and P6 parity
checks before merging. The first real-store result is recorded in the Real-data
measurement section at the end of this file.

## Fixture review follow-up

Review found that the original randomized fixture's low LCG bits repeated at
its fixed draws-per-event stride. The four-seed comparison at `04ef5d60` did not
establish the advertised model/tier/outcome variation. The sampler now scales
the full unsigned state instead of taking a low-bit remainder. Each seed asserts
at least three models, billing models and tiers in the included event scope,
both outcomes, all three stored context bands, imported history and at least
two closed dirty hours before comparing complete responses.

`ionice -c3 nice -n10 env PATH=/dev/shm/prox-bun-1.4.3/bun-linux-x64:$PATH bun test
tests/proxUsageRollup.test.ts tests/proxUsageAnalytics.test.ts`: **23 passed,
0 failed** (all 15 rollup and eight analytics tests), 246 assertions. This
follow-up changes tests and evidence only. The full verification recorded above
was not repeated. Production code, synthetic performance results and the real
imported-data merge gate are unchanged.

## Main merge and bulk-job exclusion (2026-11-13)

Merged `origin/main` at `1374f4cc` with a merge commit (`9860cced`), without
rebasing or force-pushing. Conflict resolutions preserve both branches:

- `server/usage/RULES.md`: kept recovery/replay, nightly/clientToken and exporter
  sections alongside the rollup rules; documented the admission policy below.
- `server/usage/store.ts`: kept pre-insert recovery anchoring and atomic replay
  cursor/gap/recovery progress; dirty-hour marks remain in that same transaction.
  Writer-init `recovery-checkpoint:<instance>` and `cursor:<instance>` semantics stay.
- `server/usage/writerRuntime.ts`: kept startup recovery freezing, replay priority,
  exporter commit hooks and clientToken forwarding on both start and cancel;
  rollup startup and cancellation still wrap the store lifetime.

The previous rollup implementation shared a governor and writer queue but did
not reserve bulk-job admission. Manual jobs could overlap backfill orchestration.
The smaller **refusal-and-pause policy** in `2276e1ac` fixes that, without a new
job/report kind:

- From the first backfill chunk until a no-work result, POST `/v1/jobs` returns
  409. This covers PSI/byte waits and the one-second interval between hours.
  Rejected submissions do not acquire an ID or overwrite a manual clientToken.
- A manual job admitted before backfill owns the slot. Maintenance ticks return
  without executing a chunk or advancing the dirty set/discovery cursor. They
  retry after the manual job finishes. Progress stays durable and resumable.
- Live/replay commits still use the live-first queue while all waits stay outside
  it. Backfill cancellation remains part of writer shutdown. GET `/v1/jobs`
  retains its existing manual-job report contract.

The new `proxUsageRollupJobs` tests caught HTTP 202 instead of 409 before the
fix. They now verify rejection during waits and between hours, admission only
after drain, and manual-first pause/resume without consuming progress. Full
replay, startup-recovery and clientToken tests also pass. The first full run
found one old exporter test assuming exactly one migration (3,220 passed,
1 failed). It now checks the current schema version; exporter commit/rollback
checks are retained.

Final checks used pinned Bun 1.4.3, kept `node_modules`, and used synthetic tmpfs
files only:

```sh
ionice -c3 nice -n10 env PATH=/dev/shm/prox-bun-1.4.3/bun-linux-x64:$PATH TMPDIR=/dev/shm/prox-rollup-verify-tmp bun test
ionice -c3 nice -n10 env PATH=/dev/shm/prox-bun-1.4.3/bun-linux-x64:$PATH TMPDIR=/dev/shm/prox-rollup-verify-tmp bun run verify
```

Both commands passed **3,221 tests, 0 failures**, 278 files and 36,832 assertions.
Verify also passed lint (0 errors, six existing React Refresh warnings), TypeScript,
manifest checks, the single-file Vite build and all server/worker bundles. The
existing Vite native-config-loader warning remains. No live DB access, deploy,
systemctl or live performance measurement was performed. The historical synthetic
hourly budget miss above and the real imported-data merge gate remain unchanged.

## R1/R2 review fixes and job-outcome merge (2026-11-13)

Merge commit `864597c3` brings in `origin/main` at `7e94c5c3` (#81), without
rebasing or force-pushing. The only conflict was `tests/proxUsageJobs.test.ts`.
Its whole-database verify assertion is retained unchanged: it compares every
persisted table, excluding only `meta` key `job-outcome:verify`. No rollup-table
exclusion is needed because bulk-job admission prevents maintenance writes while
verify runs. #81's persisted per-kind outcomes and exporter fields are retained.

R1 (`5bf1771a`) keeps the attempted job kind and numeric HTTP status in a safe
nightly failure report, for example `refused: {kind: 'prune', status: 409}` and
`Nightly prune admission refused (HTTP 409)`. The existing 409 regression asserts
these fields and a single submit operation, with no recovery read, retry or
cancellation. Response bodies and credentials are not copied into the report.

R2 (`efa2c452`) exposes `rollup.backfill` on bearer-protected GET `/v1/status`
through the existing writer RPC. It reports running, paused, waiting-for-job,
done or failed state; the selected UTC hour in epoch milliseconds; distinct
successfully processed hours since writer start; pause reason; and the last
safe failure with its hour and timestamp. Already-clean discovery visits count
as processed hours. The current hour clears after drain, and the last failure
remains visible after recovery. `hoursTotal` is null: status adds no history scan.
Bulk submissions refused for backfill return HTTP 409 with the safe message
`Rollup backfill in progress`. The existing refusal-and-pause policy is unchanged.

A real writer-worker regression covers authentication, status transitions,
progress, failure recovery and safe errors without exposing a synthetic private
SQLite trigger error. It also checks the HTTP 409 message. This and the existing
exclusion tests assert that backfill and refused submissions create no
`job-outcome:<kind>` metadata; backfill is not a bulk job kind.

Focused checks: the nightly suite passed **13 tests, 0 failures**; the combined
backfill-status, rollup-jobs, jobs, nightly, IO-governor and service suites passed
**46 tests, 0 failures**. Both full commands recorded in the preceding section
were rerun with pinned Bun 1.4.3, `ionice -c3 nice -n10` and tmpfs temporary files:

- `bun test`: **3,236 passed, 0 failed**, 280 files, 40.93 seconds.
- `bun run verify`: **3,236 passed, 0 failed**, 280 files, 38.90 seconds for tests;
  lint (0 errors, six existing React Refresh warnings), TypeScript, manifest
  checks, Vite single-file output and history/usage worker builds all passed.

The existing Vite native-config-loader warning remains. `node_modules` was kept.
No live DB access, systemctl, deployment or live measurement occurred. The
synthetic 30-day hourly budget miss and the coordinator's real imported-data
performance/parity gate remain unresolved; these review fixes do not claim a
performance improvement.

## Real-data measurement (2026-11-13)

The merge gate, run on a consistent copy of the live post-import database and nothing
else. The copy was made with
`sqlite3 "file:$HOME/.local/share/prox-usage/usage.sqlite?mode=ro" ".backup /dev/shm/p5b-real/usage.sqlite"`
(0.43 s, no write to the live file). Opening the copy applied migration 2 to the copy
only. No live service, unit, container or port was used. Harness:
[`scripts/usage-real-measure.ts`](../../../scripts/usage-real-measure.ts), run as a
user systemd unit under `ionice -c3 nice -n10`, using the production
`startHourlyRollups` scheduler and the live `usage-rates.json`. Raw output:
[real-data.jsonl](real-data.jsonl) (`run` 1 = backfill, whose equality phase then
rejected my 41-day window as over the API's 31-day maximum; `run` 2 = the same copy,
already backfilled, with a 31-day window instead, giving the equality and latency
results). Bun 1.4.2, not the pinned 1.4.3.

Store: **811,361 events**, 2026-10-03 07:35 to 2026-11-13 07:58 UTC, 322,109,440 bytes
at schema version 1, 787 distinct UTC hours containing events (1,290 provider
coverage rows).

### (a) Backfill

| Measure | Result |
| --- | ---: |
| Wall time, production scheduler | **827.6 s** (787 hours; 1.05 s per hour) |
| Syscall bytes read (`rchar`) | 97,733,818 (124,185 per hour) |
| Syscall bytes written (`wchar`) | 46,763,921 (59,421 per hour) |
| Governor charge at the default 4 MB/s | 144.5 MB, about 36 s of budget |
| Mean IO rate | 0.17 MB/s |
| Rollup rows / hours | 4,955 rows (6.3 per hour) / 787 hours |
| Sample blobs in rollup | 6,482,416 bytes |
| DB file growth | 322,109,440 to 332,984,320 bytes (+10.9 MB, 13.8 KB per hour) |
| Peak WAL | 4,169,472 bytes |

It completed under the default governor: PSI admission below 5%, 4 MB/s byte budget
and the one-second yield. Wall time is dominated by the one-second tick (787 s), not
by IO: pacing needed only about 36 s. All 14 progress samples show the
`between-hours` pause, none `io-pressure`; `/proc/pressure/io` `full avg10` read 0.17
to 0.30 around the run. After it, all 787 hour states are `dirty=0, supported=1`.
`rchar`/`wchar` are syscall bytes (what the governor charges), measured on tmpfs, so
they say nothing about storage-device latency or ZFS write amplification. Reads are
about twice the writes (each hour is aggregated from `events`; I did not profile the
split further). The write cost is **59 KB per hour including WAL, 13.8 KB per hour in
the database file**.

### (b) 30-day latency, raw against rollup

50 warm runs per cell after three discarded warmups, through the authenticated handler
and query worker, window `[now-30 d, now]` (so the open hour and the partial first hour
read raw even on the rollup path). No concurrent ingest. The raw path adds
`debug_force_raw: true`.

| Query | Path | p50 | p95 | Maximum | Budget | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 24 h, hourly | raw | 55.252 ms | 60.303 ms | 60.718 ms | | |
| 24 h, hourly | rollup | 9.832 ms | 13.363 ms | 17.624 ms | <150 ms | PASS |
| 30 d, daily | raw | 1,168.159 ms | 1,200.387 ms | 1,205.684 ms | | |
| 30 d, daily | rollup | 74.709 ms | 85.894 ms | 94.502 ms | <1,000 ms | PASS |
| 30 d, hourly | raw | 1,102.863 ms | 1,138.025 ms | 1,162.953 ms | | |
| 30 d, hourly | rollup | 88.871 ms | 101.303 ms | 116.067 ms | <1,000 ms | PASS |

Raw misses the 30-day budget on real data (1.14 to 1.20 s p95), which confirms the
rollup is needed; the rollup path is about 12 times faster at the 95th percentile.

### (c) Exact equality

For 17 windows, `queryAnalytics` ran with one fixed clock on a read-only connection,
raw forced and default, and the serialized `AnalyticsResponse` strings were compared
(no float tolerance, no reordering): **17 of 17 identical**. Windows: 1 d, 7 d, 30 d and
31 d (the API maximum), each at day and hour granularity; a 30 d window offset by 17 min
at both ends; an exact-hour-aligned 30 d window; a 5-day window with unaligned ends;
a single aligned hour; and a 30-minute sub-hour window. Counts per window ranged from
1,094 to 773,594 calls. In run 1 the five windows before the rejected 41-day one
(1 d, 7 d, 30 d) were also identical.

Not covered here: P6's request-detail and filter/search paths (they read raw by rule),
concurrent live ingest on this store, and storage-device latency.
