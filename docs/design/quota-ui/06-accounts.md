# Accounts list

Closes: low chip state, no-limit cell, detail type sizes, expanded detail grid, column header "counts toward total", account/plan columns, accounts toolbar split, search/sort scope, show more, compact row rule, row baseline/chevron, expanded row cue, Opus reset missing.

## Anatomy (wide)

```
ACCOUNTS
Manual resets 1   Usable resets 2   Current 2   Stale 1
[🔍 Search Claude accounts] [Sort  Name A–Z ▾] [⚠ Limits below 20%  40]   25 of 120 shown
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
- Filter chip: a toggle with one stable label in both states, "Limits below 20%", then a count badge ("40"); the count line says the same number once more in words. Off = outline with the warning icon. On = `aria-pressed="true"`, a leading check, a trailing × (decorative), the page's selected-segment fill (clearly lighter than off, ΔE ≥ 12) and a border that reads 3:1 against the card [R§4: chips]. The affected chip keeps "Affected (N)" and takes the same filled style. The red stays on the low values' icon and bar.
- The sort select keeps a visible "Sort" prefix inside its pill (same radius and height as the search and chips), so "Name A–Z" is never unlabelled; its accessible name is "Sort accounts".
- The search field keeps a visible leading label ("Search accounts", the field's `<label>` and so its accessible name) inside its pill, so it is still named once text is typed; it has no placeholder. Like the toolbar's "Averaged over" select, the label sits inside the pill rather than above it, so every toolbar control keeps one height.
- Search filters live, resets paging to the first page, and the count reads "25 of 40 matches shown · 120 total" (D < F), or "12 of 120 match" when every match is on screen (D = F). See Paging for the full table.
- "Expand all" appears only when the list shows ≤ 25 rows and is never on by default [R§4].
- On rosters over 25 rows, the toolbar and the column header are sticky within the card while the list scrolls past.

## Table

- Real table semantics; every column has a header in one style: Account, Plan, then each limit [R§4]. The counted limit's header carries a second line, "Counts toward total" in `type-label` (text, not a dot or weight).
- The limit tracks share the width the table has after the Account and Plan columns (each is its value column and gap, plus its status slot where it has one, plus an equal share, so every bar in a card is as long as the others and, per S13, at least 100px from 1440 and 90px from 1280). Plan is sized to its widest plan text, "Ultra · 2,000 points", and keeps at least 16px clear of the next cell's text (it is never narrower than its content); Account takes what the bars leave, from 160px up to its cap (18vw, at most 330px), so a long address truncates and the reset badge wraps under it when the bars need the room. A two-limit table ends at the row's right edge like a three-limit one. A limit an account lacks leaves an empty cell in its column. Columns line up inside a card, not between a two-limit and a three-limit card.
- The table shows while a card's Accounts section has room for it, and the rows read as the phone limit blocks (see Narrow) below that, whatever the screen: 900px and below always, and from 901px by the section's own width (a container query on the Accounts grid, not the viewport). The table needs 338px (chevron, Plan, two gaps, Account's 160px floor) plus, per limit column, a 12px gap, 59px of value and a bar of at least 40px, plus 54px per status slot. For three columns that is 671px with no slot, 725px with one, 779px with two and 833px with three; the grid's slot count picks the tier (`data-slots`), and a card with fewer columns uses the same widths. A 901px screen's section is 565px, a 1100px screen's 752px, so at 1100px a three-limit card with two or three status slots reads as blocks while its neighbour may stay a table. Never a table that overflows, clips or lets one cell touch another (`tableFitFailures`).
- Plan always reads "Pro · 100 points".
- Limit cell: a status slot, the value (left-aligned, tabular figures), then the bar [R§4]. A column that shows a Low mark or "Unavailable" on any row of the card has the slot on every row of that column, as wide as its widest mark, so the values start at one x and every bar track in the column shares its left and right edges; a column with neither has no slot. Empty cells use one pattern: muted text ("No 5-hour limit"), or the amber warning "Unavailable" (warning icon, `aria-hidden`, and the word; weight 600 in the counted column, 400 elsewhere, as on phones) in the slot, running into the empty value place, over a dashed empty track. The cell is named by its limit's label, and no "quota unavailable" line remains under the account name.
- Low (< 20%): neutral value, a critical ⚠ icon (`aria-hidden`) beside the visible word "Low", both in the status slot before the value, so icon, word and value read in that order on one line (`quota_pool.limit_low`, `--text-secondary`, weight 600, never red), critical fill; the track stays neutral. The visible word is the accessible text, so nothing reads "Low Low" (S5).
- Row: 40/48px; the whole summary row is the toggle (a button with `aria-expanded`); chevron 16px in a 32px cell, centred on the first text line.

## Expanded row

- A "Resets" line sits on the table's own grid: each limit's reset time directly under its bar, in `type-label`. Every limit has one ("No reset reported" when absent).
- The account facts line (Last reading, Predicted empty, Burn rate) starts at the Account column as label/value pairs in `type-label` / `type-body`. Last reading is always shown.
- Open rows get the inset band (`--bg-subtle`) over the summary row and details, and a 3px provider-colour rule on the left; a hairline separates consecutive open rows.

## Narrow (rows)

One anatomy at every roster size, at 900px and below and from 901px wherever the Accounts section is too narrow for the table (see Table), minimized or not (see "Minimized card"):

```
›  ada•••ce@ex•••.test  [Resets 1]
   Pro · 100 points
   Weekly remaining                          82.8%
   ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
   5-hour remaining                 ⚠ Low    14.0%
   ▬▬
```

- The row header holds the chevron, name, reset chip and plan, plus the stale line when the row is stale: no figure and no caption. The whole header is the toggle (the `summary`, `aria-expanded`, at least 44px tall, a visible focus ring); an open row's header takes the `--fill-hover` fill, beyond the chevron's turn, and a press shows it too. Nothing interactive sits inside it.
- One line per card, "{Window} remaining counts toward total" (for example "Weekly remaining counts toward total"), sits above the first row; it names the limit, so it does not rely on bold. It is the phone form of the wide column header's "counts toward total" cue: once per card, not per row, so no row gets taller and no row's label changes. It is hidden wherever the table shows its column header.
- The limits follow as blocks, the active window first. A block is one line, label on the left and value on the right (the Low word, icon and value stay on one line, S11), with its bar beneath. The active window leads with "{window} remaining" (for example "Weekly remaining"). A block's "Resets {date}" line sits directly under its own bar, in one type size and colour for every limit; closed rows leave reset lines to the opened row, as before.
- Closed rows show the active block, plus every other limit on short rosters (a roster of more than 8 accounts shows only the low ones). Opened rows show every limit. A bar track spans the block's full content width, under the label and value line, so every track in a card has the same left and right edges and its fill length encodes the value whatever the value text, Low word or row (this replaces S13's t16/t17 lengths). The active window's label and value use weight 600; other limits stay at regular weight.
- Unavailable: the block's value reads "Unavailable" in the same amber warning colour as the wide table's Unavailable cell, with the warning icon (`aria-hidden`), over an empty dashed track, and no separate "Weekly quota unavailable" line remains. A missing or unlimited active window keeps its reason ("Not reported", "No 5-hour limit") in the value place, with no percentage and no bar.
- A low limit keeps the neutral value, red ⚠ and bar, and the visible word "Low" (S5). Stale adds one line, "◷ Stale · Last reading 11:00 AM", in amber with a clock icon, on one line directly under the name and plan line and above the first block, because the staleness belongs to the account, not to one limit; values and bars keep the normal colour and opacity (S6).

## Minimized card

**Behaviour change, user-approved 2026-11-05 (round h2, job F).** "Minimize graph" shrinks the card's graph and nothing else. Until h2 it also swapped the Accounts table for a condensed list: on wide screens "Account | Weekly remaining | Other low limits", with no Plan, no bars and no healthy limits, and on phones a bare "71.4% / Weekly" list. Two table designs in one card read as two products, and that list is gone.

- The Accounts section of a minimized card is the card's normal table at every width: the same header, columns, Plan, bars and limits, the same phone limit blocks, and the same opened-row panel. Every cell keeps its size and its place relative to the section within 1px (`minimizedProximityFailures`). Only the plot collapses, to its compact height, so everything under it moves up as a whole.
- The pill keeps its labels and state: "Minimize graph" / "Expand graph", `aria-pressed`, and `aria-controls` on the plot.

## Estimated renewals (S7)

On the Quota Management page each estimated renewal reads "Estimated · from start date" (`quota_pool.billing_estimate_from_start`). One caveat, "Renewal dates are estimated from each plan's start date; annual plans differ.", sits once at the end of every provider's Accounts section that has an estimated renewal among any of its accounts (after the list and the optional Show more footer, never inside a row or disclosure), whatever the search, filter or paging, including a search with no match. Known dates and end-date fallbacks keep their meaning.
- Open rows add each limit's reset time beside it and the account facts as label/value rows.

## Accounts header summary

- All summary items sit in one wrapping group under the heading. Each is a label element and a value element stacked as a pair, the label above the value, in the card's Now and Forecast pattern one step smaller (label `type-label`, value 14px); values use the Manual resets value style (weight 500, tabular figures). Pairs share one top when they fit and wrap only between pairs; a pair never breaks inside or overflows its container, down to 320px.
- Items, each only when it applies: "Manual resets N", "Usable resets N", "Reporting X of Y", "Current N", "Stale N", "With a 5-hour limit X of Y".
- At 640px and below the pairs form an even grid: two equal columns (three pairs share one row when they fit), so no pair is left alone on a second line; a pair wider than its column keeps its own width and wraps as a unit. The Data collection facts in the page footer are label-above-value pairs in one row, in the same label and value type.
- The "Resets N" / "Resets N · N usable" chip in a closed row is a read-only status chip, not a control: no border, a subtle fill at least 1.15:1 against the closed, hovered and open row, `--radius-md`, text of 13px or more at 4.5:1 on that fill. "Usable" keeps its brighter neutral text so the two states stay distinct.

## Paging

- 25 rows, then "Show 25 more". The count lives in the toolbar only, never in the footer [R§4: X of Y viewed]. D = rows on screen, F = rows matching the filter or search, T = all accounts in the provider. Rosters with no toolbar (8 or fewer accounts, and not affected-only) show no count. The text, with i18next plurals on count = F in every locale:

| State | Text |
|---|---|
| No filter or search | "{D} of {T} shown" |
| Filter or search, D < F | "{D} of {F} matches shown · {T} total" |
| Filter or search, D = F | "{F} of {T} match" ("1 of 3 matches") |
| F = 0 | "No matches · {T} total" |
