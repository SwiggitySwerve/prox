# Event parity follow-up

The complete read-only recheck reduced unexplained differences **54 → 2** over
2026-11-12 21:20–23:40 UTC. Both remaining events are **awaiting reconcile** and
still fail parity. This is not a clean-night or cutover verdict. No response matrix
was run (0 pairs, 0 HTTP analytics responses).

| Count | Before (coordinator's run) | After (this run) |
| --- | ---: | ---: |
| CPAMP rows | 9,217 | 9,217 |
| Prox rows | 9,215 | 9,215 |
| Exact matches | 9,163 | 9,163 |
| Accepted matches including known TTFT representation | 9,163 | 9,215 |
| Known `ttft-zero-null` | 0 classified | 52 |
| Unexplained | 54 | **2** |

Matched by ingest: subscribed **9,215**, drained **0**, imported **0**, replayed
**0**. Reverse-only non-subscribed counts are all zero. Every other known rule,
including `ingest-gap`, counted zero. The [JSON evidence](live-events.json) retains
all difference paths and both values, with private account/label/hash fields
omitted from the two missing-row objects. The full private report remains in
`/dev/shm/prox-parity-event-followup-20261113.json`; its SHA-256 is in the JSON.

Run: 2026-11-13T00:24:32.892Z–2026-11-13T00:27:01.073Z, implementation
`2505df721a2abe3dbe1249d6a9f221e19e12cd12`, absolute deadline
`2026-11-13T00:50:00Z`. Exit **1**, `complete=true`, `status=failed`.
All 28 five-minute windows completed. The gate admitted 62 operations, minimum
2 seconds apart, with 103,747,328 measured DB bytes read, **0 bytes written** and
no PSI pauses. Admission PSI `full avg10` was 0.61 (<5); each operation was gated.

```sh
ionice -c3 nice -n10 bun scripts/usage-parity.ts \
  --from 2026-11-12T21:20:00Z --to 2026-11-12T23:40:00Z \
  --level events --deadline 2026-11-13T00:50:00Z \
  --output /dev/shm/prox-parity-event-followup-20261113
```

## Remaining losses

Both CPAMP rows were inspected read-only using `idx_usage_events_timestamp` in
the bounded 22:56:20–22:56:40 window. Their persisted latency gives:

| Execution ID | Instance | Start UTC | Latency ms | Completion UTC | Prox |
| --- | --- | --- | ---: | --- | --- |
| `4016d4e7-ed5a-4477-8164-9c9eda27cec2` | codex-primary | 22:56:28.819 | 20,345 | 22:56:49.164 | absent |
| `7d6aadf4-3ae1-43fd-b728-c793adb83196` | claude-primary | 22:56:35.308 | 14,118 | 22:56:49.426 | absent |

No recorded interval covers these completions. The nearest codex gaps are
22:54:40.244–42.816. No gap was inferred or tolerance widened. The coordinator
identified the deploy restart at 22:56:49.400 as a dual-subscriber loss and is
addressing replay in [PR #78](https://github.com/SwiggitySwerve/prox/pull/78).
The coordinator's separate tmpfs import rehearsal inserted exactly these two
with exact verification; this worker did not run that import or any live write.

## Counted rules and reconcile observation

`ttft-zero-null` accepts only persisted CPAMP TTFT **0** → Prox **null**.
Reverse null→0, other TTFT values and all latency differences still fail.
CPAMP [passes both latency and TTFT to `nullInt`](https://github.com/SwiggitySwerve/CPA-Manager-Plus/blob/52b12b45e010a766bd69ff55a55e566263d8bede/apps/manager-server/internal/repository/usageevent/repository.go#L506-L507),
which [preserves every supplied integer, including zero](https://github.com/SwiggitySwerve/CPA-Manager-Plus/blob/52b12b45e010a766bd69ff55a55e566263d8bede/apps/manager-server/internal/repository/usageevent/repository.go#L819-L823).
Thus latency can also retain zero, but this PR authorizes no latency exception.
Prox [treats unknown/unavailable TTFT as unreported](https://github.com/SwiggitySwerve/prox/blob/2505df721a2abe3dbe1249d6a9f221e19e12cd12/server/usage/normalize.ts#L400-L410).

Forward parity accepts all ingest kinds with full field comparison; reverse
parity checks subscribed rows only. Synthetic tests show that imported/reconciled
rows repair both losses only when fields match, and token drift still fails.

A strict recorded-gap rule uses completion time, requiring positive persisted
latency, the same instance and an existing half-open interval with ±2,000 ms.
The proxy [timestamps records at request start](https://github.com/SwiggitySwerve/CLIProxyAPI/blob/b62afcb3e32c6b6d0a70f944a3a273ef6eeda5fb/internal/redisqueue/plugin.go#L30-L32)
and [encodes elapsed latency in milliseconds](https://github.com/SwiggitySwerve/CLIProxyAPI/blob/b62afcb3e32c6b6d0a70f944a3a273ef6eeda5fb/internal/redisqueue/plugin.go#L147-L149),
snapshotted [when constructing the published record](https://github.com/SwiggitySwerve/CLIProxyAPI/blob/b62afcb3e32c6b6d0a70f944a3a273ef6eeda5fb/internal/runtime/executor/helps/usage_helpers.go#L609-L616).
The allowance is explicitly two [1-second collector monitor ticks](https://github.com/SwiggitySwerve/prox/blob/2505df721a2abe3dbe1249d6a9f221e19e12cd12/server/usage/collector.ts#L257-L263)
around [locally observed gap bounds](https://github.com/SwiggitySwerve/prox/blob/2505df721a2abe3dbe1249d6a9f221e19e12cd12/server/usage/collector.ts#L157-L164);
millisecond truncation contributes <2 ms. This is a bounded operational allowance,
not a guarantee of queue delivery within two seconds. Longer displacement fails.

The read-only job observation returned **not-confirmed**: no retained
import/reconcile report. Prior completion is unknown; the note never converts
missing events into matches. The uninstalled timer template now starts at
**05:00 UTC**, after the existing 04:40 reconcile schedule, without a dependency
or a guarantee that reconcile finishes first. The harness checks retained job
provenance and still stops at 12:00, with `RuntimeMaxSec=7h` as a backstop.
Neither unit was installed or enabled.

## Verification

- Focused harness suites: **58 passed**, 0 failed, 6,309 assertions, five files;
  all synthetic databases were created in `/dev/shm` and removed by fixture cleanup.
- One `bun run verify` under `ionice -c3 nice -n10`: **3,157 tests passed**,
  lint passed with six existing warnings, frontend/server/usage builds passed.
  The additional two-loss reconcile regression then passed in the focused suite.
- Standalone strict TypeScript and changed-file ESLint passed.
- Live run: complete, **exit 1 intentionally preserved**, 52 known TTFT differences,
  2 unexplained missing events awaiting reconcile. No full matrix or live import.
