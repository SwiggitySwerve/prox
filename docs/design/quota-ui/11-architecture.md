# Code architecture

The specs above only hold if the code makes the wrong thing hard. The current page is three large components and one 2,061-line stylesheet, so every fix is a local override.

## Target structure

```
src/features/quotaPool/
  model/
    poolView.ts          derivePoolView(pool, dashboard, mode, opts) → PoolView (pure, tested)
    pageView.ts          derivePageView(state, data) → PageView (header, refresh, page status, footer)
    viewState.ts         URL-backed view state: provider, window, mode, lookback, future (no offset, never reveal)
    vocabulary.ts        the terms from 09-content.md as i18n keys + formatters
  components/
    PageHeader/          title, ManageAccountsLink, ShowEmailsToggle, RefreshControl
    ViewBar/             PoolFilter, WindowToggle, MeasureToggle, ChartSettings (two prefixed native selects), DateRange
    PageStatus/          uses ui/Notice
    PoolCard/            CardHeader, Summary (Headline, FactGroup), CardNotice, ChartPanel
    Accounts/            AccountsToolbar, AccountsTable (wide), AccountRows (narrow), AccountDetail
    Charts/              PoolChart, ComparisonChart, annotationLayout.ts (collision pass)
    Footer/              AboutThisData
  QuotaPoolPage.tsx      composes regions; no styling of its own beyond the page grid
src/components/ui/
  Notice/                new shared component (tones info/warning/error/success)
  IconButton/            new shared 32/44px icon button
  ToggleChip/            new shared chip (aria-pressed)
  SegmentedControl/      new or extracted from the page
src/styles/
  tokens.scss            spacing, type, radius, control sizes, semantic colours (02-foundations.md)
```

## Rules

1. **View models own every decision.** `derivePoolView` returns, for one card: chip `{tone, icon, label}` (never null; neutral when ready), headline `{value | null, metricLabel, contextLabel, meter | null}`, a fact group `{title, slots: [{label, value, aside}] × 4}`, notice `{tone, text, action: 'show-affected' | null} | null`, chart config (marker time, annotations, horizon label, low zone), and account rows with per-cell `{value, bar, state, resetLabel}` plus `affected` flags. Components only render slots. All state branching (13 `forecastState` branches today) lives here and is unit-tested against every row of the tables in `05-states.md`.
2. **Loading is a view model too.** `derivePoolView(null)` returns slots marked `loading`, and each slot component renders its own skeleton — one layout for both.
3. **Shared UI first.** Use `components/ui` for buttons, selects, sheet, table, empty state, skeleton; add Notice, IconButton, ToggleChip, SegmentedControl there so other pages benefit.
4. **One stylesheet per component**, each under ~150 lines, using only tokens. No hex values, no `!important`, no viewport media queries inside components — use container queries with the three tiers from `03-page-layout.md`.
5. **Grids are named.** Card summary and accounts table use `grid-template-areas` with shared column-track custom properties (`--acct-cols`) set once per page so every provider table aligns.
6. **Tests:** view-model tests per state table row; component tests for the anatomy (slot order, one notice, one action); the capture harness keeps the measured checks and adds: no element moves > 4px between skeleton and loaded; no two annotation labels overlap; every control in the view bar shares one top edge.

## What stays

- Data fetching (`usePoolDashboard`, `poolResource`), domain types, chart geometry maths, formatters, i18n keys that match the vocabulary.
