# Content: vocabulary and copy rules

Closes: counts jargon, degraded repeats, pool empty "not before", latest reading repeat, drain vs burn, ambiguous sources copy, empty-state copy, error copy, "+100 points".

## Vocabulary (one term per idea)

| Idea | Term | Not |
|---|---|---|
| most recent sample | Latest reading (chart marker shows its time) | snapshot, now, last observed |
| account sample is old | Stale since 11:00 AM | last reported at, last observed |
| account has no sample | Unavailable | no current quota data, missing |
| coverage | 2 of 3 current | loaded · eligible, current · stale |
| withheld total | — + "Withheld · 2 of 3 current" | Unavailable at headline size, Total unavailable |
| combined total not computed | Not summed | unverified account overlap |
| forecast beyond the horizon | After Nov 10 | Not before, Not in this range |
| showing pre-failure data | Showing data from 12:00 PM UTC | Saved snapshot (as a chip or marker) |
| low | Below 20% | low (unqualified) |
| net change including resets | Drain rate | — |
| usage only | Burn rate (3h) | Burn, last 3h |
| the collector's last attempt | Last collection | Last collection attempt |
| paging | Showing 25 of 120 · Show 25 more | Show all 80 accounts, 25 of 120 shown |

## Copy rules

- One fact, one place (`05-states.md`).
- Every number carries its unit ("248.4 points", "3.7 points/h", "Pro · 100 points").
- Absolute times are in the viewer's time zone with its abbreviation; relative times ("in 1d 4h") only as asides next to an absolute time [R§6].
- Notices: what happened, what it means, and what happens next, in ≤ 2 sentences [R§3]. Errors say why and what to do in plain words; raw codes go in Details [R§7]. No false promises.
- Empty state: "No accounts connected" · "Connect a Claude or ChatGPT (Codex) account to start tracking quota." · "Open OAuth Login".
- Lists of accounts in prose are avoided; affected accounts are shown by filtering the list.
- Sentence case for labels and buttons; no colons after labels; the ellipsis is "…".
