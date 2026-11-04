# Accounts list

Closes: low chip state, no-limit cell, detail type sizes, expanded detail grid, column header "counts toward total", account/plan columns, accounts toolbar split, search/sort scope, show more, compact row rule, row baseline/chevron, expanded row cue, Opus reset missing.

## Anatomy (wide)

```
ACCOUNTS                                                          2 of 3 current
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
- Search filters live, resets paging to the first page, and the count reads "12 of 120 shown · 12 match", or "12 of 120 match" when every match is on screen.
- "Expand all" appears only when the list shows ≤ 25 rows and is never on by default [R§4].
- On rosters over 25 rows, the toolbar and the column header are sticky within the card while the list scrolls past.

## Table

- Real table semantics; every column has a header in one style: Account, Plan, then each limit [R§4]. The counted limit's header carries a second line, "Counts toward total" in `type-label` (text, not a dot or weight).
- Column tracks are shared by every provider table on the page (a limit an account lacks leaves an empty track), so Claude and Codex columns line up.
- Plan always reads "Pro · 100 points".
- Limit cell: value right-aligned with tabular figures, then the bar [R§4]. Empty cells use one pattern: muted text ("Unavailable", "No 5-hour limit") over a dashed empty track.
- Low (< 20%): neutral value, a critical ⚠ icon (`aria-hidden`) beside the visible word "Low" (`quota_pool.limit_low`, `--text-secondary`, weight 600, never red), critical fill; the track stays neutral. The visible word is the accessible text, so nothing reads "Low Low" (S5).
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
- An opened row does not list the active window a second time: its list item is hidden, and one line under the heading, spanning the name and value columns, reads "{window} · Resets {date}" (for example "Weekly · Resets Oct 28, 12:00 PM UTC"). The line is omitted when the limit has no reset time. The heading keeps its value, low mark and stale line; every other limit keeps its value, warning, bar and reset.
- A low limit stays in the compact line: neutral value, red ⚠ and bar, and the visible word "Low" (S5). Stale adds one line, "◷ Stale · Last reading 11:00 AM", in amber with a clock icon, on one line; values and bars keep the normal colour and opacity (S6). Unavailable replaces that limit's value with "Unavailable".

## Minimized list (≥ 901px)

- A minimized card's closed rows and their header row (Account | `<active window> remaining` | Other low limits) are left-aligned and content-sized, on the same column tracks in every minimized card on the page. The Account track is `min(max-content of name + reset chip, 40ch)`; the name ends in an ellipsis beyond 28ch (or where the card runs out of room) and then carries a `title` with the whole name; the chip never wraps below it. The value track is `max(14ch, header width)`. The other-low track takes the rest. Closed rows without a status line have equal height. The rightmost Account item in a card is at most 160px from the leftmost value in that card.
- The primary column holds the active window's remaining value (weekly or 5-hour), right-aligned and on one line, with the low mark when it is low. The third column holds every other low limit, including Weekly Opus, as label, value, ⚠ and "Low"; several sit inline and wrap only when the card runs out of room, and none is hidden. It is empty when there are none. The reset chip stays in the Account cell, and "Expand all" stays beside the list header.
- Opening a row restores every limit and fact; it spans the card's content width (the t15 fact panel, S3). At ≤ 900px the minimized list keeps its single bounded column.

## Estimated renewals (S7)

On the Quota Management page each estimated renewal reads "Estimated · from start date" (`quota_pool.billing_estimate_from_start`). One caveat, "Renewal dates are estimated from each plan's start date; annual plans differ.", sits directly under the Accounts header of every provider section that has an estimated renewal among any of its accounts, whatever the search, filter or paging. Known dates and end-date fallbacks keep their meaning.
- Open rows add each limit's reset time beside it and the account facts as label/value rows.

## Paging

- 25 rows, then "Show 25 more". The count lives in the toolbar only, never in the footer [R§4: X of Y viewed]: "25 of 120 shown" (D of T), plus " · 40 match" (F) while a filter or search is active. When D = F it reads "F of T match" instead ("40 of 120 match"). D = rows on screen, F = rows matching the filter or search, T = all accounts in the provider. Rosters with no toolbar (8 or fewer accounts, and not affected-only) show no count.
