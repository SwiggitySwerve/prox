# P5b hourly-rollup evidence

Measured with Bun 1.4.3 on 2026-11-12. No live database, service, unit or container was changed.
P5 and the subsequent manual-job/deployment wiring are merged from `origin/main`.

**The final synthetic 30-day hourly budget fails.** Its p95 is 1,031.383 ms against
<1,000 ms. The daily and 24-hour budgets pass. The coordinator must measure both
paths on the same real imported history before merging; this evidence does not
satisfy that gate.

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
checks before merging. No real-data result is claimed here.

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
