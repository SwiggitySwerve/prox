# Quota page hill-climb: rounds and checks

Route `#/quota` (Quota Management). Each round: synthetic fixtures captured with `scripts/visual/prox-quota-capture.py`, scored 1.0–10.0 per screen and aspect by independent reviewer subagents (art director, product, accessibility, information architect), median per cell. A cell passes at 9.0 with no failed measured check.

Rounds 0–10 showed reviewers the previous round's medians; from round 11 they scored blind (previous screenshots only). Reviewers ran on Claude Sonnet 5.5 through round 9 and Claude Opus 5.5 from round 10.

## Per round

| Round | Reviewers | Cells ≥ 9.0 | Cells ≥ 8.0 | Mean | Lowest | Captures | Failed checks |
|---|---|---|---|---|---|---|---|
| 0 | 3 | 0/64 | 4 | 6.55 | 5.0 | 27 | 0 |
| 1 | 3 | 0/64 | 5 | 6.97 | 6.0 | 27 | 0 |
| 2 | 3 | 0/64 | 6 | 7.06 | 6.0 | 27 | 0 |
| 3 | 3 | 0/64 | 6 | 7.08 | 6.0 | 27 | 0 |
| 4 | 3 | 0/64 | 12 | 7.19 | 7.0 | 27 | 0 |
| 5 | 4 | 0/81 | 13 | 7.59 | 7.1 | 29 | 0 |
| 6 | 4 | 0/81 | 17 | 7.73 | 7.2 | 29 | 0 |
| 7 | 4 | 0/90 | 17 | 7.80 | 7.3 | 34 | 0 |
| 8 | 4 | 0/90 | 44 | 7.96 | 7.5 | 34 | 0 |
| 9 | 4 | 0/90 | 58 | 8.04 | 7.6 | 34 | 0 |
| 10 | 4 | 0/90 | 65 | 8.07 | 7.7 | 35 | 0 |
| 11 | 4 | 0/90 | 76 | 8.23 | 7.5 | 35 | 0 |
| 12 | 4 | 0/90 | 83 | 8.24 | 7.4 | 35 | 0 |
| 13 | 4 | 0/90 | 87 | 8.34 | 7.8 | 35 | 0 |
| 14 | 4 | 0/90 | 88 | 8.34 | 7.9 | 35 | 0 |
| 15 | 4 | 0/90 | 89 | 8.34 | 7.8 | 35 | 0 |
| 16 | 4 | 1/90 | 89 | 8.45 | 7.9 | 35 | 0 |
| 17 | 4 | 0/90 | 88 | 8.32 | 7.8 | 35 | 0 |
| 18 | 4 | 0/90 | 89 | 8.42 | 7.9 | 35 | 0 |
| 19 | 4 | 0/90 | 87 | 8.38 | 7.8 | 35 | 0 |
| 20 | 4 | 0/90 | 90 | 8.38 | 8.0 | 35 | 0 |
| 21 | 4 | 0/90 | 90 | 8.49 | 8.2 | 35 | 0 |
| 22 | 4 | 0/90 | 90 | 8.37 | 8.1 | 35 | 0 |
| 23 | 4 | 0/90 | 90 | 8.50 | 8.1 | 35 | 0 |
| 24 | 4 | 0/90 | 89 | 8.43 | 7.9 | 35 | 0 |
| 25 | 4 | 0/90 | 90 | 8.39 | 8.0 | 35 | 0 |
| 26 | 4 | 0/90 | 90 | 8.45 | 8.1 | 35 | 0 |
| 27 | 4 | 0/90 | 90 | 8.46 | 8.1 | 35 | 0 |

Rounds 14–15 added the header refresh busy state, roster paging (25 rows, then "Show all"), and a marked "counts toward total" limit column in place of the duplicate remaining column. Rounds 16–18 fitted the 5-hour and rate charts to their data, named Claude's 7-day window Weekly, and moved the disabled control's reason under it. Rounds 19–21 named the accounts behind a partial or stale total with a "Refresh now" action, kept the metric named beside an unavailable total, dated "Pool empty" against the server's forecast horizon in every view, moved notices across the card, and made the low filter a neutral toggle. Round 20 was the first with every cell at 8.0 or more; Round 22 put a "Refresh now" on every notice, which three reviewers flagged as three buttons for one action; round 23 kept the one on the combined card, which also names the accounts, centred the row chevrons, and dimmed stale values to #888 while low values stay red. Round 23 has the best mean so far. Round 24 demoted the rate-view "Remaining-quota forecast" heading to a plain label; all four reviewers pinned a −0.7 grouping drop on it, and round 25 restored it (+0.5). Rounds 24–25 also made the refresh error say the page retries on its own, matched the loading skeleton to the loaded layout, and dropped the repeated weekly line from collapsed phone rows. Rounds 26–27 moved the combined card's view select into its title row, put every card's notice under its headline, aligned an unavailable caption to its word, tinted low-limit tracks red, split the phone selects evenly, and named the sort key. Open at round 27: the loading skeleton still places the combined select under the headline (loading consistency −0.5), and on phones the select now sits between the title and the number. Round 16 had the run's only passing cell (empty state, colour, 9.0). From round 16 on, a lens's mean moved up to ±0.3 between rounds on screens that did not change, so a 9.0 median is within reviewer noise of most cells.

Measured checks every round: text contrast 4.5:1 (3:1 large), targets 24px (44px touch), no page overflow or clipped text, meaning-colour thresholds, nesting depth below 4 surfaces, and no hidden reason for a disabled control.

## Round 18 medians

| Screen | Hierarchy | Layout | Type and numbers | Colour | Content | Controls and states | Consistency | Responsive and accessible | Grouping |
|---|---|---|---|---|---|---|---|---|---|
| 1-ready | 8.6 | 8.4 | 8.6 | 8.6 | 8.4 | 8.4 | 8.6 | 8.3 | 8.4 |
| 2-empty | 8.8 | 8.4 | 8.8 | 8.9 | 8.6 | 8.6 | 8.6 | 8.6 | 8.8 |
| 3-loading | 8.4 | 8.2 | 8.6 | 8.6 | 8.6 | 8.4 | 8.3 | 8.3 | 8.4 |
| 4-error | 8.8 | 8.6 | 8.6 | 8.6 | 8.7 | 8.6 | 8.6 | 8.6 | 8.6 |
| 5-degraded-data | 8.3 | 8.1 | 8.2 | 8.3 | 7.9 | 8.2 | 8.2 | 8.1 | 8.1 |
| 6-accounts-expanded | 8.4 | 8.2 | 8.2 | 8.6 | 8.4 | 8.4 | 8.3 | 8.2 | 8.2 |
| 7-forecast-views | 8.4 | 8.2 | 8.4 | 8.3 | 8.1 | 8.6 | 8.1 | 8.1 | 8.1 |
| 8-refreshing | 8.6 | 8.4 | 8.6 | 8.6 | 8.4 | 8.2 | 8.4 | 8.4 | 8.4 |
| 9-200-accounts | 8.5 | 8.4 | 8.6 | 8.4 | 8.3 | 8.2 | 8.3 | 8.3 | 8.4 |
| 10-no-5-hour-limit | 8.5 | 8.4 | 8.4 | 8.6 | 8.5 | 8.4 | 8.4 | 8.2 | 8.4 |

## What kept cells below 9.0

- Reviewers still asked for a quieter toolbar, one name for the weekly window across providers ("7-day limit" vs "Weekly limit"), and fewer repeated timestamps in the refresh-error state.
- Reviewers asked for further wording and grouping changes on degraded states (stale counted as loaded, reasons with an action).
