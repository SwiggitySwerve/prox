# Accounts list

Closes: low chip state, no-limit cell, detail type sizes, expanded detail grid, column header "counts toward total", account/plan columns, accounts toolbar split, search/sort scope, show more, compact row rule, row baseline/chevron, expanded row cue, Opus reset missing.

## Anatomy (wide)

```
ACCOUNTS                                                          2 of 3 current
[🔍 Search Claude accounts] [Sort: Name A–Z ▾] [Below 20% (40)]   Showing 25 of 120  [Expand all]
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│    Account                Plan               5-hour         Weekly          Weekly Opus      │
│                                                             Counts toward total              │
│ ›  ada•••ce@ex•••.test    Pro · 100 points     62.0% ▬▬▬▬    82.8% ▬▬▬▬▬▬    45.0% ▬▬▬        │
│ ⌄  gra•••er@ex•••.test    Pro · 100 points   ⚠ 14.0% ▬       82.8% ▬▬▬▬▬▬    45.0% ▬▬▬        │
│ ┃  Resets                                     Oct 27, 1 PM   Oct 28, 12 PM   Oct 28, 12 PM    │
│ ┃  Last reading 12:00 PM UTC   Predicted empty Oct 30   Burn rate 1.2 points/h               │
└─────────────────────────────────────────────────────────────────────────────────────────┘
[Show 25 more]
```

## Toolbar

- One row under the section heading [R§4: ≤ 5 toolbar actions]: search, sort, low filter, count, expand all. Count and Expand all sit right.
- Scoped labels: "Search Claude accounts"; sort options "Name A–Z" (default: stable across the 15s reloads, honest; the server order is sha256-id order) and "Lowest limit first" (accounts with no data first, then lowest percent, then name) [R§4: one column sorted by default; council decision 4b].
- Low filter: a toggle chip labelled with its rule, "Below 20% (40)". Off = outline; on = filled with a leading check and `aria-pressed` [R§4: chips]. The red stays on the low values.
- Search filters live, resets paging to the first page, and the count reads "Showing 12 of 120".
- "Expand all" appears only when the list shows ≤ 25 rows and is never on by default [R§4].
- On rosters over 25 rows, the toolbar and the column header are sticky within the card while the list scrolls past.

## Table

- Real table semantics; every column has a header in one style: Account, Plan, then each limit [R§4]. The counted limit's header carries a second line, "Counts toward total" in `type-label` (text, not a dot or weight).
- Column tracks are shared by every provider table on the page (a limit an account lacks leaves an empty track), so Claude and Codex columns line up.
- Plan always reads "Pro · 100 points".
- Limit cell: value right-aligned with tabular figures, then the bar [R§4]. Empty cells use one pattern: muted text ("Unavailable", "No 5-hour limit") over a dashed empty track.
- Low (< 20%): critical value, ⚠ icon, critical fill; the track stays neutral.
- Row: 40/48px; the whole summary row is the toggle (a button with `aria-expanded`); chevron 16px in a 32px cell, centred on the first text line.

## Expanded row

- A "Resets" line sits on the table's own grid: each limit's reset time directly under its bar, in `type-label`. Every limit has one ("No reset reported" when absent).
- The account facts line (Last reading, Predicted empty, Burn rate) starts at the Account column as label/value pairs in `type-label` / `type-body`. Last reading is always shown.
- Open rows get the inset band (`--bg-subtle`) over the summary row and details, and a 3px provider-colour rule on the left; a hairline separates consecutive open rows.

## Narrow (rows)

One anatomy at every roster size:

```
›  ada•••ce@ex•••.test                         82.8%
   Pro · 100 points                        Weekly ●
   5-hour 62.0% ▬▬▬      Opus 45.0% ▬▬
```

- The counted limit is the row value, captioned with its name; the other limits are one compact line (value + mini bar each), always shown, at every roster size.
- A low limit stays in the compact line, critical with ⚠. Stale adds one line ("◷ Stale since 11:00 AM"). Unavailable replaces that limit's value with "Unavailable".
- Open rows add each limit's reset time beside it and the account facts as label/value rows.

## Paging

- 25 rows, then "Show 25 more"; the count lives in the toolbar ("Showing 25 of 120") [R§4: X of Y viewed]. After the last page, "Show fewer".
