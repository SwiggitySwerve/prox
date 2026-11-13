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

`ttft-zero-null` accepts persisted CPAMP TTFT **0** → Prox **null** only when
CPAMP's own metadata decoder establishes **unknown/unavailable instrumentation**.
A follow-up bounded read-only classification of all 52 original differences found
**52 unavailable, 0 unknown, 0 first-byte, 0 substantive-content, 0 fallback-packet**.
Thus **0 measured zeros** were excused and the **54 → 2** verdict is unchanged.
The [classification report](ttft-classification.json) lists every execution ID,
start, persisted zero and raw method; 30 gated operations read 26,626,785 bytes,
wrote zero and incurred no PSI pause. This was a metadata classification of the
completed run, not another full event comparison.
CPAMP [explicitly preserves measured zero for all three measured methods](https://github.com/SwiggitySwerve/CPA-Manager-Plus/blob/52b12b45e010a766bd69ff55a55e566263d8bede/apps/manager-server/internal/usage/analytics.go#L117-L130);
negative regressions cover each.
Reverse null→0, other TTFT values and all latency differences still fail.
CPAMP [passes both latency and TTFT to `nullInt`](https://github.com/SwiggitySwerve/CPA-Manager-Plus/blob/52b12b45e010a766bd69ff55a55e566263d8bede/apps/manager-server/internal/repository/usageevent/repository.go#L506-L507),
which [preserves every supplied integer, including zero](https://github.com/SwiggitySwerve/CPA-Manager-Plus/blob/52b12b45e010a766bd69ff55a55e566263d8bede/apps/manager-server/internal/repository/usageevent/repository.go#L819-L823).
Thus latency can also retain zero, but this PR authorizes no latency exception.
Prox [treats unknown/unavailable TTFT as unreported](https://github.com/SwiggitySwerve/prox/blob/2505df721a2abe3dbe1249d6a9f221e19e12cd12/server/usage/normalize.ts#L400-L410).

Forward parity accepts all ingest kinds with full field comparison; reverse
parity checks subscribed rows only. Synthetic tests show that imported/reconciled
rows repair both losses only when fields match, and token drift still fails.

The recorded-gap rule now requires completion strictly inside the recorded
half-open interval for the same instance, with **zero tolerance**. Positive
persisted latency is required. The proxy
[timestamps records at request start](https://github.com/SwiggitySwerve/CLIProxyAPI/blob/b62afcb3e32c6b6d0a70f944a3a273ef6eeda5fb/internal/redisqueue/plugin.go#L30-L32)
and [encodes elapsed latency in milliseconds](https://github.com/SwiggitySwerve/CLIProxyAPI/blob/b62afcb3e32c6b6d0a70f944a3a273ef6eeda5fb/internal/redisqueue/plugin.go#L147-L149).
The former ±2-second allowance was removed after review; tests reject completion
just outside both bounds, including equality with the exclusive upper bound.
Neither remaining loss is covered, before or after that tightening.

The original run's read-only job observation returned **not-confirmed**: no retained
import/reconcile report. Prior completion is unknown; that note never converts
missing events into matches. The replacement disabled **04:20 UTC nightly chain**
now waits for prune → reconcile → optional backup → parity in order. Backup is
skipped by default (`PROX_USAGE_ENABLE_PACED_BACKUP=0`) until the paced snapshot
and restore gates land. It stops at failure, noon or a forbidden boundary, requests
active-job cancellation, and has a 7h40min oneshot backstop. Parity is capped at
5h30min and receives an absolute noon deadline. Separate job timers are no longer
shipped; manual per-job units remain. No unit was installed or enabled.

The synthetic evidence helper now passes its ephemeral job URL and synthetic
key explicitly, and asserts both status requests. A test preload blocks fetch,
Node TCP and Bun TCP attempts to ports 18317/18320/8317/8319; unconsumed attempts
fail the test even when application code catches the network error.

## Verification after review fixes

- Harness, nightly, service and job suites: **89 passed**, 0 failed, 6,679
  assertions, nine files. Synthetic databases and credentials lived in `/dev/shm`
  and were removed by fixture cleanup. Fake jobs test terminal cleanup, ordering,
  failure stop, noon/forbidden cutoffs, cancellation, delayed starts and parity
  exit 2; port guards prove no live fixture endpoint is used.
- One new `bun run verify` under `ionice -c3 nice -n10`: **3,168 tests passed**,
  0 failed, 36,309 assertions; lint passed with six existing warnings and all
  frontend/server/usage builds passed.
- Standalone strict TypeScript passed, including the nightly script and guard.
- Original live run: complete, **exit 1 intentionally preserved**. The follow-up
  bounded TTFT classification confirms **52 unavailable, 0 measured**; 2 missing
  events remain unexplained awaiting reconcile. No full matrix, live import or
  live chain execution.
