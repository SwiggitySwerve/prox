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

Rounds 14–15 added the header refresh busy state, roster paging (25 rows, then "Show all"), and a marked "counts toward total" limit column in place of the duplicate remaining column. Final capture after round 15 (three small fixes, not re-scored): 35 captures, 0 failed checks.

Measured checks every round: text contrast 4.5:1 (3:1 large), targets 24px (44px touch), no page overflow or clipped text, meaning-colour thresholds, nesting depth below 4 surfaces, and no hidden reason for a disabled control.

## Round 15 medians

| Screen | Hierarchy | Layout | Type and numbers | Colour | Content | Controls and states | Consistency | Responsive and accessible | Grouping |
|---|---|---|---|---|---|---|---|---|---|
| 1-ready | 8.6 | 8.3 | 8.4 | 8.8 | 8.2 | 8.2 | 8.4 | 8.4 | 8.2 |
| 2-empty | 8.8 | 8.2 | 8.8 | 8.9 | 8.6 | 8.7 | 8.7 | 8.8 | 8.7 |
| 3-loading | 8.3 | 8.1 | 8.6 | 8.7 | 8.4 | 8.3 | 8.1 | 8.2 | 8.3 |
| 4-error | 8.7 | 8.5 | 8.6 | 8.8 | 8.4 | 8.6 | 8.5 | 8.6 | 8.4 |
| 5-degraded-data | 8.1 | 8.1 | 8.2 | 8.4 | 7.8 | 8.2 | 8.1 | 8.2 | 8.1 |
| 6-accounts-expanded | 8.3 | 8.1 | 8.1 | 8.7 | 8.2 | 8.3 | 8.2 | 8.2 | 8.2 |
| 7-forecast-views | 8.3 | 8.1 | 8.1 | 8.6 | 8.0 | 8.2 | 8.1 | 8.1 | 8.1 |
| 8-refreshing | 8.5 | 8.3 | 8.4 | 8.8 | 8.3 | 8.2 | 8.3 | 8.4 | 8.2 |
| 9-200-accounts | 8.4 | 8.3 | 8.4 | 8.4 | 8.1 | 8.1 | 8.1 | 8.1 | 8.2 |
| 10-no-5-hour-limit | 8.4 | 8.2 | 8.2 | 8.6 | 8.1 | 8.2 | 8.2 | 8.1 | 8.2 |

## What kept cells below 9.0

- The 5-hour view keeps the 10-day chart range.
- Rate views keep the full date range, so recorded rates fill a sliver of the plot.
- Reviewers still asked for a quieter toolbar, one name for the weekly window across providers ("7-day limit" vs "Weekly limit"), and fewer repeated timestamps in the refresh-error state.
- Reviewers asked for further wording and grouping changes on degraded states (stale counted as loaded, reasons with an action).
