# Components

Closes: two refresh indicators, retry countdown, notice order/style, refresh-now placement, unavailable hero, card header grid varies, forecast heading, weekly facts in 5-hour view, "+100 points" dangling, latest-reading repeat, reorder icons, error/empty widths.

Each component has one anatomy. A state changes what fills a slot, never the layout.

## RefreshControl (page header)

The page's only refresh affordance [R§1, R§6].

```
[⟳ Updated 12:00 PM UTC · next 0:58]     idle
[◌ Refreshing…                       ]     busy: spinner, aria-busy, click disabled
[⊗ Refresh failed                    ]     failed: status only while PageStatus owns the retry
```

- Accessible name is fixed: `aria-label="Refresh quotas"`. The visible status is a separate span linked with `aria-describedby`.
- Min-width 32ch so text changes never move neighbours. Times are absolute with the zone [R§6]; the countdown uses tabular figures.
- A persistent `role="status"` region (always in the DOM) announces only state changes: "Refreshing quotas", "Quotas updated at 12:00 PM", "Refresh failed". Countdown ticks are never announced [R§6].
- On phones it shrinks to the icon plus "12:00 PM".

## PageStatus (page-level notice)

At most one [R§3], directly under the page header.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⊗  Could not refresh quotas                  Retrying in 59s [Try again] │
│    Showing data from 12:00 PM UTC.  ▸ Details (HTTP 503)                │
└──────────────────────────────────────────────────────────────────────┘
```

- Uses the shared Notice anatomy, tone `error`. Plain-language message first; the raw error code goes in an expandable "Details" [R§7].
- It owns the retry countdown and the only retry action while shown. RefreshControl reads "Refresh failed" and is not clickable.
- `role="status"` for a refresh failure (saved data is still shown, so it isn't urgent); `role="alert"` only for a first-load failure with no data [R§6].
- First-load failure and empty state replace the content region with the app's `EmptyState` anatomy (title, one sentence, one primary action), full content width, left-aligned block [R§7].

## Notice (shared, four tones)

```
▎◐ Title (optional, one line)                          [Action]
▎  One or two sentences.
```

| Tone | Icon | Colour | Used for |
|---|---|---|---|
| info | `info` | grey | collecting history, not summed, saved data context |
| warning | ◐ / ◷ | amber | partial data, stale data |
| error | `x-circle` | critical | request failed |
| success | `check-circle` | green | reserved for confirmations; the Ready chip is neutral, not green (council decision 1) |

- 3px left rule + 10% tone fill, `radius-card`, `space-3` padding, ≤ 2 lines, ≤ 1 action, never auto-dismissed [R§3].
- Card notices sit in the card's notice slot, directly under the summary. Page notices sit under the page header. Never between a control and what it controls.

## PoolCard (template for the combined and provider cards)

```
┌ header ─────────────────────────────────────────────────────────────────┐
│ ✳ Claude  3 accounts  [◐ Partial]        [⤡ Minimize graph] [↓ Move down]   │
├ summary ────────────────────────────────────────────────────────────────┤
│ 248.4                        │ WEEKLY FORECAST                             │
│ Weekly remaining             │ Pool empty   First empty   Next reset   Burn rate (3h) │
│ of 300 points                │ After Nov 10 Oct 29        Oct 28        3.7 points/h   │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░  (meter)    │              12:00 PM UTC  12:00 PM UTC                 │
│                              │                            +100 · in 1d 4h              │
├ notice slot ────────────────────────────────────────────────────────────┤
├ chart ──────────────────────────────────────────────────────────────────┤
├ accounts (provider cards only) ─────────────────────────────────────────┤
└─────────────────────────────────────────────────────────────────────────┘
```

### Header

- Provider mark, title (`type-title`), account count, then the status chip. The chip shows in every state in one pill shape with a word and an icon; "Forecast: Ready" is neutral (secondary text, check icon), the others keep their tone (council decision 1).
- Right side, the same `.reorder` group on every card: labelled pills with icons, "Minimize graph" / "Expand graph" and, on provider cards, "Move up" / "Move down". The words show at every width, are never truncated, and sit on one line. Pills are 32px tall (44px on coarse pointers and phones). An impossible move (first card up, last card down) isn't drawn. Each accessible name starts with its visible label, e.g. "Move up (Claude)". There is no card menu: a menu hides the one control that says what the card does (`14-council-decisions` §5).
- Combined card: a chart-view select ("Stacked providers" / "Provider lines") sits beside the actions from 901px up, on its own right-aligned row under the title and actions at 641–900px, and on its own row under the title and toggle on phones (the heading and toggle keep one row; the heading may wrap).
- Provider cards: identity (name, account count, chip) on the left and the actions on the right. If both don't fit on one line, the actions take their own row directly under the identity, right-aligned from 641px up and left-aligned on phones. On phones the rows are the identity, then the actions. When every card's title, count and chip fit one line, all stay inline; otherwise every card puts its chip on its own second identity line (one page-wide choice).

### Summary: headline

- Remaining view: `type-display` number with its two-line caption beside it: metric ("Weekly remaining") and context ("of 300 points"). Drain and Burn views: the one-line label ("Drain rate (3h)") sits above the number, and "points/h" shares the number's baseline. Label then number is also the DOM order, so the label never sits beside the number and long numbers never push it. In those views the balance ("Weekly remaining **248.4** of 300 points") is the headline's context line under the rate: the number in the value style (500, tabular) and "of 300 points" in the same muted unit style as "points/h". Nothing stands under a "Now" heading there, because it would hold a single fact.
- A thin capacity meter under the headline (Remaining view): remaining / capacity in the provider colour, with a tick at the 20% low threshold.
- **Withheld total:** `—` in muted display size; label line 1 unchanged; line 2 becomes the reason: "Withheld · 2 of 3 current" (or "Not summed" on the combined card). No meter. The notice explains.

### Summary: facts

- A labelled group: section heading names the window ("Weekly forecast" / "5-hour forecast") — this also answers "are these weekly facts?" in the 5-hour view.
- Four fixed slots. Every slot reserves three lines: label (`type-label`), value (`type-body` 500), aside (`type-label`). From 720px, Now sits beside Forecast and Forecast's three facts share one row whenever the card has room for them (headline, Now and the facts all on one row only at ≥ 1200px card width); a card too narrow for three wraps the last fact rather than overflowing. The capture's `forecastRowFailures` check holds this at 1280, 1440 and 1920. Below 720px the Now facts stack full width under the headline as a label-left, value-right list; at 900px and below the Forecast facts read label over value, as on wide cards, in one group that wraps between pairs. Fact columns are sized to their content (at most 16rem), left-aligned directly after the headline block, and never stretched across the card or right-aligned. A fact's value never wraps or clips.

| Slot | Remaining view | Drain / Burn view | Combined card |
|---|---|---|---|
| 1 | Pool empty | Pool empty | Claude remaining |
| 2 | First account empty | First account empty | Codex remaining |
| 3 | Next reset (aside: +100 · in 1d 4h) | Next reset | First pool empty |
| 4 | Burn rate (3h) | none: the balance (248.4 of 300) is the headline's context line | Next reset |

- Withheld forecast: the slots keep their labels; values read "—" and the aside reads "Needs all accounts". Next reset still shows.
- One horizon: "After Nov 10" means the projection reaches the forecast horizon without emptying. The chart shows the same horizon (edge label "empty after Nov 10 →") so the fact and the chart never disagree.

### Chart and accounts

See `07-charts.md` and `06-accounts.md`.

## Footer

```
ABOUT THIS DATA
History since   Oct 24, 12:00 PM UTC        Last collection   Oct 27, 12:05 PM UTC · failed (HTTP 503)
▸ How these numbers work
```

- One group, `type-section` heading; facts as a description list [R§2]; the disclosure inside the group.
- The disclosure holds labelled items: Plan weights (a two-column table with a caption), Reading the chart (stacked bands and provider lines), Burn vs drain, Refresh cadence, Forecast horizon.
