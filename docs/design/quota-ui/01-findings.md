# Findings: what 6,242 reviewer notes say

Source: every note from the four blind reviewers (art director, product, accessibility, information architect) in rounds 10–27 of the quota-page hill-climb — 72 reviews, 6,242 notes. Notes were grouped into themes by keyword; a note can count toward more than one theme, and about a third (mostly one-off polish) fit no theme.

## The headline

- Median scores have sat between 8.32 and 8.50 since round 13 (15 rounds). No cell has passed 9.0 since round 16.
- **Every theme below was raised in nearly all 18 rounds, by all four reviewers, and is still being raised in rounds 24–27.** Local fixes moved individual cells but never closed a theme.
- The lowest-scoring aspects across all notes are structural: layout (8.24), responsive/accessible (8.26), consistency (8.30), controls/states (8.30). Colour (8.53) and hierarchy (8.46) are the strongest.
- Reviewer noise is about ±0.3 per lens between rounds on unchanged screens, so a 0.1–0.2 polish fix is invisible in a four-reviewer median. Only a structural change moves the average.

## Root causes in the code

| Measure | Current |
|---|---|
| Stylesheet | one 2,061-line `QuotaPoolPage.module.scss` for the whole page, 105 class names |
| Breakpoints | 31 media queries over 8 different conditions (640, 900/901, 1200, 1300, 1450, pointer:fine…) |
| Type | 10 font sizes (11, 12, 13, 14, 15, 16, 18, 22, 40px and a clamp) |
| Radii | 9 values (3, 4, 5, 10, 12, 16, 999px, 50%, inherit) |
| Control heights | 8 values (24, 28, 32, 36, 38, 40, 44px and 0) |
| Colours | 15 hard-coded hex values; a private `$pool-error: #ff5252` because the app's `--error-color` (#f2766b) is nearly Claude coral (#ed9877) |
| `!important` | 12 |
| Components | `PoolCard.tsx` 625 lines: data shaping, 13 `forecastState` branches, 39 ternaries, header, facts, notice, chart, toolbar, table, rows and details in one function |
| Shared UI | the app ships `Button`, `Select`, `Table`, `Sheet`, `EmptyState`, `Skeleton`, `ToggleSwitch`; the quota page uses none of them except `Skeleton` |
| State model | none: each component derives its own copy and layout from `forecastState`, `status` and `mode` |

These map directly onto the themes: no layout primitives → layout and consistency notes; no state model → degraded-state and content notes; no component reuse → control-style notes; no breakpoint system → responsive notes.

## Themes

Columns: notes in the theme · rounds it appeared in (of 18) · reviewers raising it (of 4) · mean score of those notes · screens most affected.

### A. Page frame and controls

The page has no single control bar or header contract, so every control lands somewhere slightly different.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| toolbar baseline labels | 60 | 17 | 4 | 8.32 | 1-ready, 6-accounts-expanded, 8-refreshing |
| date nav wrap float | 122 | 18 | 4 | 8.29 | 1-ready, 3-loading, 8-refreshing |
| phone control stack | 36 | 15 | 4 | 8.31 | 1-ready, 8-refreshing, 4-error |
| pill control styles | 160 | 18 | 4 | 8.28 | 3-loading, 9-200-accounts, 1-ready |
| stacked select position | 68 | 16 | 4 | 8.24 | 1-ready, 5-degraded-data, 7-forecast-views |
| disabled select | 106 | 18 | 4 | 8.31 | 7-forecast-views, 1-ready, 9-200-accounts |
| header icon cluster | 115 | 17 | 4 | 8.45 | 1-ready, 8-refreshing, 2-empty |

Recent examples:

- r24 ia: In the toolbar, only 'Rate interval' and 'Future usage' have labels above them. The unlabelled 'Weekly/5-hour' and 'Remaining/Drain rate/Burn rate' pi
- r24 ia: On the phone, 'Resets Oct 27, 1:00 PM UTC' lines are set at the same size and colour as the 'Weekly limit' labels above them, so they read as more lim
- r24 a11y: Date navigator 'Oct 24 – Nov 3 < Today >': on wide it now sits inline after 'Future usage', leaving ~550px empty to its right; on laptop it drops to i

### B. Status, refresh and retry

Refresh state is expressed in four places (shell icon, header countdown, error banner, chart caption) with no single owner.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| two refresh indicators | 102 | 18 | 4 | 8.33 | 8-refreshing, 1-ready, 4-error |
| refresh status width shift | 47 | 18 | 4 | 8.36 | 8-refreshing, 10-no-5-hour-limit, 1-ready |
| retry countdown in banner | 60 | 16 | 4 | 8.57 | 4-error |
| last collection failed | 76 | 18 | 4 | 8.38 | 1-ready, 8-refreshing, 4-error |
| saved amber dot | 65 | 18 | 4 | 8.58 | 4-error, 5-degraded-data |
| loading status placement | 89 | 18 | 4 | 8.41 | 3-loading, 8-refreshing, 4-error |

Recent examples:

- r24 a11y: Refresh state appears in two places: the toolbar spinner (top right) and 'Refreshing…' next to 'Show emails'
- r24 artdirector: The header 'Refreshing…' keeps a static refresh icon while the toolbar refresh button shows a spinner. Two different icons for the same state.
- r24 a11y: Header row: 'Refreshing…' is shorter than 'Auto-refresh in 60s', so the header right edge shifts

### C. Degraded, empty and error states

There is no state model: each component decides for itself how to say "missing", "stale" or "failed", so the same fact is told three ways.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| unavailable hero | 244 | 18 | 4 | 8.17 | 5-degraded-data, 7-forecast-views, 10-no-5-hour-limit |
| notice order style | 162 | 18 | 4 | 8.42 | 4-error, 5-degraded-data, 7-forecast-views |
| refresh now placement | 85 | 16 | 4 | 8.26 | 5-degraded-data, 4-error, 2-empty |
| degraded repeats | 61 | 17 | 4 | 8.01 | 5-degraded-data |
| partial status line | 110 | 18 | 4 | 8.20 | 5-degraded-data, 3-loading, 8-refreshing |
| stale dimming | 110 | 18 | 4 | 8.24 | 5-degraded-data, 4-error, 10-no-5-hour-limit |
| partial vs stale dot | 70 | 18 | 4 | 8.29 | 5-degraded-data, 4-error |
| counts jargon | 123 | 18 | 4 | 8.02 | 5-degraded-data, 10-no-5-hour-limit, 1-ready |
| error banner width layout | 104 | 18 | 4 | 8.48 | 4-error, 2-empty, 7-forecast-views |
| empty card width | 90 | 18 | 4 | 8.37 | 2-empty, 4-error |
| empty accounts link | 178 | 18 | 4 | 8.62 | 2-empty, 1-ready, 3-loading |
| ambiguous sources copy | 34 | 15 | 4 | 8.17 | 7-forecast-views |

Recent examples:

- r24 a11y: 'Unavailable' headline is now smaller (improved), but in grey it still reads as the same weight as the warning strip below it
- r24 a11y: Caption 'Weekly quota remaining / of 500 points' floats high beside 'Unavailable' (top at y≈317 against a baseline of ≈345) and doesn't align to the w
- r24 a11y: Refresh-error banner sits between the control row and 'Combined usage', pushing the data down

### D. Card summary (headline + facts)

The card summary changes shape by view and state instead of filling fixed slots.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| card header grid varies | 77 | 18 | 4 | 8.26 | 3-loading, 7-forecast-views, 1-ready |
| forecast heading style | 153 | 18 | 4 | 8.22 | 7-forecast-views, 1-ready, 10-no-5-hour-limit |
| weekly facts in 5h view | 30 | 8 | 4 | 8.38 | 10-no-5-hour-limit |
| plus points dangling | 106 | 18 | 4 | 8.29 | 10-no-5-hour-limit, 1-ready, 8-refreshing |
| pool empty not before | 74 | 15 | 4 | 8.37 | 10-no-5-hour-limit, 7-forecast-views, 1-ready |
| latest reading repeat | 87 | 18 | 4 | 8.32 | 1-ready, 4-error, 8-refreshing |
| hero label wrap phone | 45 | 17 | 4 | 8.25 | 9-200-accounts, 10-no-5-hour-limit, 3-loading |
| drain vs burn | 68 | 17 | 4 | 8.29 | 7-forecast-views, 1-ready, 3-loading |

Recent examples:

- r24 artdirector: Card header facts at 1440/1280: 'Next reset Oct 28, 12:00 PM UTC' carries an extra '+100 points' line, so the 2x2 metric grid has uneven rows. 'Burn, 
- r24 artdirector: The skeleton layout differs from the loaded layout: date-navigator position, and the provider-card metric skeleton is a 4-column row while loaded is a
- r24 a11y: 'Remaining-quota forecast' (pool card, drain/burn views) was bold and now uses the same small grey style as 'Weekly remaining', so it no longer reads 

### E. Accounts list

The table, its expanded details, the phone rows and the large-roster rows are four layouts of one list.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| low chip state | 255 | 18 | 4 | 8.31 | 9-200-accounts |
| no limit cell | 206 | 18 | 4 | 8.29 | 10-no-5-hour-limit |
| detail type sizes | 177 | 18 | 4 | 8.24 | 6-accounts-expanded, 4-error, 1-ready |
| expanded detail grid | 121 | 18 | 4 | 8.16 | 6-accounts-expanded, 4-error |
| reorder icons | 120 | 18 | 4 | 8.27 | 1-ready, 6-accounts-expanded, 10-no-5-hour-limit |
| column header counted | 108 | 16 | 4 | 8.38 | 10-no-5-hour-limit, 1-ready, 8-refreshing |
| account plan columns | 92 | 18 | 4 | 8.23 | 10-no-5-hour-limit, 1-ready, 6-accounts-expanded |
| accounts toolbar split | 88 | 18 | 4 | 8.30 | 9-200-accounts, 6-accounts-expanded, 5-degraded-data |
| search sort scope | 49 | 18 | 4 | 8.21 | 9-200-accounts, 7-forecast-views, 3-loading |
| show more button | 55 | 14 | 4 | 8.29 | 9-200-accounts |
| compact row rule | 43 | 17 | 4 | 8.12 | 9-200-accounts, 1-ready, 6-accounts-expanded |
| row baseline chevron | 49 | 16 | 4 | 8.26 | 1-ready, 6-accounts-expanded, 4-error |
| expanded row cue | 51 | 18 | 4 | 8.40 | 6-accounts-expanded |
| opus reset missing | 35 | 17 | 4 | 8.25 | 6-accounts-expanded |

Recent examples:

- r24 a11y: On the 200-account roster the 'Search accounts / Default order / 40 low' tools sit below 'Accounts', past the fold of a long card
- r24 a11y: The '40 low' toggle doesn't say what 'low' means
- r24 a11y: Ultra row: 'No 5-hour limit' text starts at the bar's left edge with no bar track, so that column's alignment breaks

### F. Charts

Annotations are placed independently and collide; ticks and legends are not sized to the plot.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| reset tick collision | 170 | 18 | 4 | 8.24 | 6-accounts-expanded, 10-no-5-hour-limit, 7-forecast-views |
| chart axis ticks | 56 | 16 | 4 | 8.22 | 1-ready, 7-forecast-views, 10-no-5-hour-limit |
| snapshot edge | 57 | 15 | 4 | 8.24 | 7-forecast-views, 10-no-5-hour-limit, 4-error |
| legend wrap | 58 | 15 | 4 | 8.27 | 1-ready, 5-degraded-data, 8-refreshing |
| low red vs coral | 56 | 17 | 4 | 8.51 | 1-ready, 4-error, 5-degraded-data |

Recent examples:

- r24 a11y: Phone: axis labels 'Oct 25 / Oct 30' and 'points' are ~12px grey on near-black; desktop 'Resets…' and the 'counts toward total' sublabels are small an
- r24 artdirector: Narrow expanded: 'Resets Oct 27, 1:00 PM UTC' lines use the same 14px grey as the '5-hour limit' labels, while 'Last reading' facts drop to 13px. Thre
- r24 product: Narrow burn: the x-axis shows only 'Oct 25' and 'Oct 27' over a 3-day range, and the 'Snapshot' label hugs the right edge.

### G. Loading

The skeleton is a separate hand-drawn layout, so it drifts from the real one every time the real one changes.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| loading skeleton mismatch | 214 | 18 | 4 | 8.29 | 3-loading |

Recent examples:

- r24 a11y: Skeleton puts a 220px date-navigator block at the far right of the control row, but the loaded page now puts the navigator inline after 'Future usage'
- r24 a11y: Skeleton control row (two pills, two selects, right-hand block) doesn't match the loaded row order

### H. Footer and background

"Data collection" and "About these numbers" have no section of their own.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| footer data collection | 70 | 14 | 4 | 8.43 | 1-ready, 8-refreshing, 4-error |
| about disclosure structure | 143 | 18 | 4 | 8.32 | 6-accounts-expanded, 1-ready, 8-refreshing |

Recent examples:

- r24 a11y: 'Data collection' block and the 'About these numbers' disclosure sit loose below the last card, separated only by a hairline
- r24 artdirector: Every chart repeats a 'Latest reading · Oct 27, 12:00 PM UTC · …' footer, and the 'Snapshot' marker already shows the same moment.
- r24 a11y: 'Data collection' block and the 'About these numbers' disclosure sit loose below the last card, separated only by a hairline

### I. Type and contrast

Ten font sizes and ad-hoc greys leave small secondary text near the contrast floor.

| Theme | Notes | Rounds | Reviewers | Mean | Screens |
|---|---|---|---|---|---|
| small grey text | 63 | 18 | 4 | 8.32 | 1-ready, 6-accounts-expanded, 4-error |

Recent examples:

- r24 a11y: Secondary text: 'Pro · 100 points', 'counts toward total' and axis ticks are ~12px grey, next to 15px row text
- r24 a11y: Phone: axis labels 'Oct 25 / Oct 30' and 'points' are ~12px grey on near-black; desktop 'Resets…' and the 'counts toward total' sublabels are small an

