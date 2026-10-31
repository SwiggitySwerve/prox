# States: one model, every slot defined

Closes: unavailable hero, degraded repeats, partial status line, stale dimming, partial vs stale dot, counts jargon, saved amber dot, refresh-now placement, last collection failed, empty accounts link, ambiguous sources copy, loading status placement.

## The rule: say each fact once, at its level

State is computed once, in the view models (`11-architecture.md`). Each component renders slots.

| Level | Says | Never says |
|---|---|---|
| Page (RefreshControl, PageStatus) | the request failed, data is saved, the retry | which account is missing |
| Card (chip + notice) | why the total or forecast is withheld, and how many accounts | per-account names or times |
| Row | this account is unavailable or stale, and since when | the consequence for the total |
| Chart | where readings stop; the latest reading's time | the reason |

## Card states

| State | Chip | Headline | Facts | Notice (tone · text · action) | Chart |
|---|---|---|---|---|---|
| ready | neutral "Forecast: Ready" ✓ | value + meter | all slots | — | recorded + projected |
| collecting | ⓘ Collecting | value if known, else — | Next reset; others "—" with aside "Needs more history" | info · "Collecting history: 1 reading so far. A forecast appears after about an hour." | compact strip |
| partial | ◐ Partial | — · "Withheld · 2 of 3 current" | Next reset, Burn; others "—" · "Needs all accounts" | warning · "1 account has no current data, so the total is withheld." · [Show affected accounts] | recorded until the gap; gap edges labelled [R§8] |
| stale | ◷ Stale | — · "Withheld · 2 of 3 current" | as partial | warning · "1 account hasn't reported recently, so the total is withheld." · [Show affected accounts] | as partial |
| no limit (5-hour, all accounts) | ⓘ No limit | "No 5-hour limit" in `type-title` muted | — | — | none |
| not summed (combined) | ⓘ Not summed | — · "Not summed" | per-provider slots still filled | info · "Some accounts may appear in two sources, so the combined total is hidden." | provider lines; "Stacked" disabled with the reason |
| refresh failed | unchanged (the card's own state) | unchanged | unchanged | — (PageStatus says it once) | marker shows the latest reading's time, which carries its age |

- "Show affected accounts" filters the card's list to the affected rows (and sorts them first), so the names are one click away even on page 5 of a 200-account roster. Refresh lives only in RefreshControl/PageStatus.
- Coverage always reads "2 of 3 current". Capacity reads "of 300 points". Paging reads "Showing 25 of 120". No other "of".

## Row states

| Row | Account cell | Limit cells | Notes |
|---|---|---|---|
| ok | name · plan | value + bar | — |
| stale | name · plan · "◷ Stale since 11:00 AM" (amber) | values in `--text-quaternary`; bars at the 3:1 dim mix (`02-foundations.md`) | the whole row dims; a low value keeps its ⚠ icon |
| unavailable (error / missing window) | name · plan | the affected cell: "Unavailable" in muted text over a dashed empty track, sr text "Weekly limit unavailable" | no separate status line |
| no limit | name · plan | "No 5-hour limit" in muted text over a dashed empty track | one empty-cell pattern for both |
| disabled | not listed | — | — |

## Page states

| State | Header | Page status | View bar | Content | Footer |
|---|---|---|---|---|---|
| first load | title; RefreshControl busy "Loading…" | — | real controls, enabled | skeleton cards from the real templates (`08-loading.md`) | hidden |
| empty | title only (no "Manage accounts") | — | hidden | EmptyState: "No accounts connected" · "Connect a Claude or ChatGPT (Codex) account to start tracking quota." · [Open OAuth Login] | hidden |
| first-load error | title; RefreshControl | — | hidden | EmptyState-shaped error panel (role=alert) with [Try again] and Details | hidden |
| refresh failed | RefreshControl "Refresh failed" | error notice with countdown + [Try again] + Details | normal | cards keep their own states | "Last collection … · failed (HTTP 503)" |
| refreshing | RefreshControl busy | — | normal | unchanged (data kept on screen) [R§5] | unchanged |
| disconnected | RefreshControl disabled | info notice "Not connected to the proxy. Showing data from 12:00 PM UTC." | normal | cards keep their states | unchanged |
