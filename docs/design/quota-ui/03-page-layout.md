# Page layout: regions and the responsive model

Closes: toolbar baseline/labels, date navigator wrap/float, phone control stack, header icon cluster, stacked-select position, disabled select, refresh-status width shift, footer, hero label wrap on phones.

## Regions, top to bottom

```
┌ Page header ──────────────────────────────────────────────────────────────┐
│ Quota Management   Manage accounts →     Show emails ◯   [⟳ Updated 12:00 PM UTC · next 0:58] │
├ Page status (only when something is wrong page-wide) ─────────────────────┤
│ ⊗ Could not refresh quotas. Showing data from 12:00 PM UTC.  Retrying in 59s  [Try again] │
├ View bar ─────────────────────────────────────────────────────────────────┤
│ (All pools) (✳ Claude 3) (◆ Codex 2)                                        │
│ [Weekly|5-hour]  [Remaining|Drain|Burn]  [Rate 3h ▾] [Future Same as now ▾] ‹ Oct 24 – Nov 3 ›  [Today] │
├ Content ──────────────────────────────────────────────────────────────────┤
│ Combined usage card → Claude card → Codex card                            │
├ Footer ───────────────────────────────────────────────────────────────────┤
│ ABOUT THIS DATA  History since … · Last collection … · ▸ How these numbers work │
└───────────────────────────────────────────────────────────────────────────┘
```

| Region | Question it answers | Contents |
|---|---|---|
| Page header | Where am I, and is it current? | Title; "Manage accounts →" (a text link); "Show emails" (the app's `ToggleSwitch`); RefreshControl, the page's only refresh affordance [R§1, R§6] |
| Page status | Is something wrong with the whole page? | At most one page-level notice [R§3]: refresh failed, disconnected. It sits under the header and above the view bar, because it qualifies everything below it |
| View bar | What am I looking at? | Pool filter; window; measure; Rate interval and Future usage (inline, prefixed); date range |
| Content | The data | Combined card, then provider cards, in the user's order |
| Footer | Where does this come from? | One group: collection facts and the "How these numbers work" disclosure |

### Rules

- **Global vs local.** The view bar holds only controls that change every card [R§1]. "Rate interval" and "Future usage" change every card's facts and projections, so they stay **inline and visible** (council decision 2, `14-council-decisions.md`): native selects with the setting's name as a prefix inside the box ("Rate 3h", "Future Same as now"), the `<label>` kept as a visually hidden accessible name. That gives every view-bar control one top edge. When Future usage doesn't apply to the current measure it is disabled, and its reason ("Applies to Remaining view") stays visible on the same row, wired through `aria-describedby`. Fallback only if the phone view bar measures over budget: a popover whose trigger shows the current values.
- **Chart-only controls stay on their card.** The combined card's "Stacked / Provider lines" switch is in that card's header.
- **One baseline.** Every view-bar control has the same height and sits on one line. Segmented controls carry a visually hidden label ("Window", "Measure") [R§1: Primer].
- **Date range.** `‹ Oct 24 – Nov 3 ›` stepper plus a "Today" button. "Today" is disabled when already showing today; `›` is disabled at the furthest forecast day. The range is the last group, right-aligned on wide.
- **Reserved widths.** Text that changes (RefreshControl status, counts) sits in a fixed min-width box so neighbours never move.
- **View state in the URL.** `provider`, `window`, `mode`, `lookback` and `future` are kept in the URL (defaults omitted, allow-listed, `replace` writes), so views can be shared and survive reloads. Not `offset` (relative to today) and never `reveal` (privacy). Per-card sort and filters stay in component state. Ships last (council decision 4a).

## Content width and grid

- Page padding 16px, 24px at ≥ 1280px [R§11]. Content max-width 1440px.
- Cards and page panels (status, empty, error) span the full content width; long text inside them is capped at 65ch.
- Inside a card: named grid areas (see `04-components.md`), with the summary split headline | facts.

## Responsive model

Viewport media queries for the page frame; container queries for cards and tables [R§9].

### Page frame (viewport)

| Width | Header | View bar |
|---|---|---|
| ≥ 1100px | one row | one row: pools · window · measure · options · range |
| 768–1099px | one row | two rows: (pools) / (window · measure · options · range) — the whole row reflows, never one orphaned control |
| < 768px | title row; then actions row | row 1: pool menu ("All pools ▾") + RefreshControl (icon + time); row 2: Window segmented + Measure segmented (Primer: never wrap a segmented control; if it can't fit, switch it to a menu); row 3: the two prefixed selects splitting the row; row 4: range stepper |

Budget: on a 390 × 844 screen the first headline number starts no lower than 360px from the top.

### Cards (container)

| Tier | Card width | Summary | Facts | Accounts |
|---|---|---|---|---|
| Wide | ≥ 1200px | headline · facts side by side | one row of 4 slots | table, shared column tracks |
| Medium | 720–1199px | headline · facts side by side | 2 × 2 | table, plan under the account name |
| Narrow | < 720px | headline, then facts | label/value list | rows (`06-accounts.md`) |

- Touch targets 44px on coarse pointers, 24px minimum everywhere [R§9].
- Reflow at 320px without two-way scrolling; only the chart and table may scroll inside themselves [R§9].

## Shell (outside this page)

The refresh/globe/log-out cluster belongs to the app shell. On this page, the shell refresh triggers the same request as RefreshControl and shows the same busy state. Council decision 3: `.header-actions` loses its border and outer shadow (split from `.mobile-sidebar-actions`), keeping the translucent background and blur because content scrolls under the fixed header. Re-aligning it to the title baseline goes to the shell owner.
