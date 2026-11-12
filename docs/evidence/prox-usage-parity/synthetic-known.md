# Usage parity: passed

UTC window: 2026-10-13T22:17:23.456Z to 2026-11-13T22:17:23.456Z.

Matrix quick: 672 generated cases; 1 selected; 2/2 maximum pairs completed (4 HTTP responses; 0 second pages absent on both; 0 paging mismatches).
Limited/sample run: yes; not a cutover gate. D5 local replays: 4.

| Mode | Plan count | Generated base queries | Maximum pages/pairs/responses | Reconciliation |
| --- | ---: | --- | --- | --- |
| quick | 720 | 60 filter combinations × 4 rotating spans + 24 searches × 3 providers × 2 models × 3 outcomes = 240 + 432 = 672 | 2 pages × 672 = 1344 pairs; × 2 servers = 2688 responses | Plan count is not reproduced by the checked-in generators. 0 source cases dropped; time-zone slots mapped to UTC. Two pages × 672 = up to 1,344 pairs; two servers × 1,344 = 2,688 responses. |
| full | 22,464 | 60 filter combinations × 12 spans + 24 searches × 3 providers × 2 models × 3 outcomes × 12 spans = 720 + 5,184 = 5,904 | 2 pages × 5904 = 11808 pairs; × 2 servers = 23616 responses | Plan count is not reproduced by the checked-in generators. 0 source cases dropped; time-zone slots mapped to UTC. Two pages × 5,904 = up to 11,808 pairs; two servers × 11,808 = 23,616 responses. |

Generator source: CPA-Manager-Plus commit 52b12b45e010a766bd69ff55a55e566263d8bede. Both source files were clean at this commit; blob IDs are in the JSON. No alternate generator version explaining the plan counts was identified.

| Axis | CPAMP rollup generator | CPAMP search generator | Harness |
| --- | --- | --- | --- |
| Ranges | 6 lengths × aligned/unaligned = 12; quick rotates 4 | same 12; quick rotates 1 | identical selections; caller window clipping reported separately |
| Buckets/granularities | hour/day in 8 rotating view slots (4/4) | hour/day in 5 rotating view slots (3/2) | same rotation; not an extra Cartesian factor |
| Outcomes | 3 | 3 | 3 in both families |
| Providers | 5: empty, claude, CODEX, gemini, nobody | 3: empty, claude, CODEX | same 5 / 3 |
| Models | 2: empty, shared-model | same 2 | same 2 |
| Search terms | 2: empty, needle | 24 | same 2 / 24 slots; 3 search-fixture-only terms replaced with shared-column session, trace and tier terms |
| Time zones | 5 distinct zones in 8 coupled view slots | 5 distinct zones in 5 coupled view slots | 1 (UTC); all 8 / 5 slots preserved, 0 query cases removed |
| Pages | 1 | 1 | 1 plus page 2 when both have it; one-sided page 2 fails parity |

Window adjustments: 56 cases clipped to requested start; 0 cases entirely outside requested window. Source cases: 672.

Compared pairs: 2; equal: 0; unexplained: 0.

- Known d5-pricing: 2 pairs
- Known detail-trace: 2 pairs
- Known detail-provider: 2 pairs

Pair rule counts can overlap. The following counts are individual differing fields/events:

- unexplained: 0
- d5-pricing: 86
- detail-provider: 6
- detail-trace: 6
- drained-during-cpamp-outage: 0
- ingest-gap: 0

The JSON contains every difference with both values and the two queries/cursors. Known differences are counted, not discarded.
