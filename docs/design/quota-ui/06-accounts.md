# Accounts list

Closes: low chip state, no-limit cell, detail type sizes, expanded detail grid, column header "counts toward total", account/plan columns, accounts toolbar split, search/sort scope, show more, compact row rule, row baseline/chevron, expanded row cue, Opus reset missing.

## Anatomy (wide)

```
ACCOUNTS
Manual resets 1   Usable now 2   Current 2   Stale 1
[🔍 Search Claude accounts] [Sort: Name A–Z ▾] [Show 40 with a limit below 20%]   25 of 120 shown
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

- One row under the section heading [R§4: ≤ 5 toolbar actions]: search, sort, filter chip(s), then the count as the toolbar's last item. From 641px it is one wrapping row; at 640px and below search, sort, each chip and the count take a full-width row each, in that order, with 44px targets. Expand all sits in the section heading.
- Scoped labels: "Search Claude accounts"; sort options "Name A–Z" (default: stable across the 15s reloads, honest; the server order is sha256-id order) and "Lowest limit first" (accounts with no data first, then lowest percent, then name) [R§4: one column sorted by default; council decision 4b].
- Filter chip: a toggle labelled with its rule. Off = outline with the warning icon, "Show 40 with a limit below 20%". On = "Filtering to 40 with a limit below 20%", `aria-pressed="true"`, a leading check, the page's selected-segment fill (clearly lighter than off, ΔE ≥ 12) and a border that reads 3:1 against the card [R§4: chips]. The affected chip keeps "Affected (N)" and takes the same filled style. The red stays on the low values' icon and bar.
- Search filters live, resets paging to the first page, and the count reads "25 of 40 matches shown · 120 total" (D < F), or "12 of 120 match" when every match is on screen (D = F). See Paging for the full table.
- "Expand all" appears only when the list shows ≤ 25 rows and is never on by default [R§4].
- On rosters over 25 rows, the toolbar and the column header are sticky within the card while the list scrolls past.

## Table

- Real table semantics; every column has a header in one style: Account, Plan, then each limit [R§4]. The counted limit's header carries a second line, "Counts toward total" in `type-label` (text, not a dot or weight).
- The limit tracks share the width the table has after the Account and Plan columns (`minmax(104px, 1fr)` each), so a two-limit table ends at the row's right edge like a three-limit one. A limit an account lacks leaves an empty cell in its column. Columns line up inside a card, not between a two-limit and a three-limit card.
- Plan always reads "Pro · 100 points".
- Limit cell: a status slot, the value (left-aligned, tabular figures), then the bar [R§4]. A column that shows a Low mark or "Unavailable" on any row of the card has the slot on every row of that column, as wide as its widest mark, so the values start at one x and every bar track in the column shares its left and right edges; a column with neither has no slot. Empty cells use one pattern: muted text ("No 5-hour limit"), or the amber warning "Unavailable" (warning icon, `aria-hidden`, and the word; weight 600 in the counted column, 400 elsewhere, as on phones) in the slot, running into the empty value place, over a dashed empty track. The cell is named by its limit's label, and no "quota unavailable" line remains under the account name.
- Low (< 20%): neutral value, a critical ⚠ icon (`aria-hidden`) beside the visible word "Low", both in the status slot before the value, so icon, word and value read in that order on one line (`quota_pool.limit_low`, `--text-secondary`, weight 600, never red), critical fill; the track stays neutral. The visible word is the accessible text, so nothing reads "Low Low" (S5).
- Row: 40/48px; the whole summary row is the toggle (a button with `aria-expanded`); chevron 16px in a 32px cell, centred on the first text line.

## Expanded row

- A "Resets" line sits on the table's own grid: each limit's reset time directly under its bar, in `type-label`. Every limit has one ("No reset reported" when absent).
- The account facts line (Last reading, Predicted empty, Burn rate) starts at the Account column as label/value pairs in `type-label` / `type-body`. Last reading is always shown.
- Open rows get the inset band (`--bg-subtle`) over the summary row and details, and a 3px provider-colour rule on the left; a hairline separates consecutive open rows.

## Narrow (rows)

One anatomy at every roster size, at 900px and below (closed rows of a minimized card keep their compact list):

```
›  ada•••ce@ex•••.test  [Resets 1]
   Pro · 100 points
   Weekly remaining                          82.8%
   ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
   5-hour remaining                 ⚠ Low    14.0%
   ▬▬
```

- The row header holds only the chevron, name, reset chip and plan: no figure and no caption.
- The limits follow as blocks, the active window first. A block is one line, label on the left and value on the right (the Low word, icon and value stay on one line, S11), with its bar beneath. The active window leads with "{window} remaining" (for example "Weekly remaining"). A block's "Resets {date}" line sits directly under its own bar, in one type size and colour for every limit; closed rows leave reset lines to the opened row, as before.
- Closed rows show the active block, plus every other limit on short rosters (a roster of more than 8 accounts shows only the low ones). Opened rows show every limit. A bar track spans the block's full content width, under the label and value line, so every track in a card has the same left and right edges and its fill length encodes the value whatever the value text, Low word or row (this replaces S13's t16/t17 lengths). The active window's label and value use weight 600; other limits stay at regular weight.
- Unavailable: the block's value reads "Unavailable" in the same amber warning colour as the wide table's Unavailable cell, with the warning icon (`aria-hidden`), over an empty dashed track, and no separate "Weekly quota unavailable" line remains. A missing or unlimited active window keeps its reason ("Not reported", "No 5-hour limit") in the value place, with no percentage and no bar.
- A low limit keeps the neutral value, red ⚠ and bar, and the visible word "Low" (S5). Stale adds one line, "◷ Stale · Last reading 11:00 AM", in amber with a clock icon, on one line directly under the active block; values and bars keep the normal colour and opacity (S6).

## Minimized list (≥ 901px)

- A minimized card's closed rows and their header row (Account | `<active window> remaining` | Other low limits) are left-aligned and content-sized, on the same column tracks in every minimized card on the page. The Account track is `min(max-content of name + reset chip, 40ch)`; the name ends in an ellipsis beyond 28ch (or where the card runs out of room) and then carries a `title` with the whole name; the chip never wraps below it. The value track is `max(14ch, header width)`. The other-low track takes the rest. Closed rows without a status line have equal height. The rightmost Account item in a card is at most 160px from the leftmost value in that card.
- The primary column holds the active window's remaining value (weekly or 5-hour), right-aligned and on one line, with the low mark when it is low. The third column holds every other low limit, including Weekly Opus, as label, value, ⚠ and "Low"; several sit inline and wrap only when the card runs out of room, and none is hidden. It is empty when there are none. The reset chip stays in the Account cell, and "Expand all" stays beside the list header.
- Opening a row restores every limit and fact; it spans the card's content width (the t15 fact panel, S3). At ≤ 900px the minimized list keeps its single bounded column.

## Estimated renewals (S7)

On the Quota Management page each estimated renewal reads "Estimated · from start date" (`quota_pool.billing_estimate_from_start`). One caveat, "Renewal dates are estimated from each plan's start date; annual plans differ.", sits once at the end of every provider's Accounts section that has an estimated renewal among any of its accounts (after the list and the optional Show more footer, never inside a row or disclosure), whatever the search, filter or paging, including a search with no match. Known dates and end-date fallbacks keep their meaning.
- Open rows add each limit's reset time beside it and the account facts as label/value rows.

## Accounts header summary

- All summary items sit in one wrapping group under the heading. Each is a label element and a value element; values use the Manual resets value style (weight 500, tabular figures). A pair wraps as a unit and never breaks inside or overflows its container, down to 320px.
- Items, each only when it applies: "Manual resets N", "Usable now N", "Reporting X of Y", "Current N", "Stale N", "5-hour limit X of Y".
- The "Resets N" / "Resets N · N usable" chip in a closed row is a read-only status chip, not a control: no border, a subtle fill at least 1.15:1 against the closed, hovered and open row, `--radius-md`, text of 13px or more at 4.5:1 on that fill. "Usable" keeps its brighter neutral text so the two states stay distinct.

## Paging

- 25 rows, then "Show 25 more". The count lives in the toolbar only, never in the footer [R§4: X of Y viewed]. D = rows on screen, F = rows matching the filter or search, T = all accounts in the provider. Rosters with no toolbar (8 or fewer accounts, and not affected-only) show no count. The text, with i18next plurals on count = F in every locale:

| State | Text |
|---|---|
| No filter or search | "{D} of {T} shown" |
| Filter or search, D < F | "{D} of {F} matches shown · {T} total" |
| Filter or search, D = F | "{F} of {T} match" ("1 of 3 matches") |
| F = 0 | "No matches · {T} total" |
