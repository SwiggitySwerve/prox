# Delivery and evaluation

## Order of work

Each phase keeps the test suite green and is captured with the same 35-case harness (plus the new cases below).

1. **Tokens and shared components**: `tokens.scss`, `--critical-color`, `--skeleton-bg`; Notice, IconButton, ToggleChip, SegmentedControl in `components/ui`. No visible change to the quota page yet.
2. **View models**: `derivePageView`, `derivePoolView` with a test for every row of the tables in `05-states.md`. Existing components switch to reading them, with no visible change.
3. **Page frame**: PageHeader + RefreshControl, PageStatus, shell box restyle, ViewBar (inline prefixed settings selects, one baseline), Footer; URL view state last.
4. **PoolCard template**: header, summary (headline + meter, fact slots), notice slot, chart panel; combined card on the same template.
5. **Accounts**: toolbar, shared-track table, expanded rows, narrow rows, sticky header, "Show affected accounts".
6. **Charts**: annotation collision pass, marker time, ticks, low zone, horizon label, legend groups, figure semantics + summary sentence.
7. **Loading**: skeletons from the view models; first-viewport shift check.
8. **Remove** the old stylesheet and components.

## How to evaluate

- **Theme closure first.** For each theme in `01-findings.md`, record "closed / still present" with the evidence (capture or check). A phase is done when its themes are closed.
- **Pairwise judgement.** Each round, reviewers also say per screen: better / same / worse than the previous round, with one line why. This sees 0.1–0.2 gains that the medians can't.
- **Persistence rule.** Act on a note only if two reviewers raise it, or one reviewer raises it in two consecutive rounds. Never reverse a decision in the log below because of a single note.
- **Absolute scores** keep the four-lens median, 0.1 granularity, and the 9.0 bar.
- **New harness checks**: every view-bar control shares one top edge; no annotation labels overlap; skeleton-to-data shift ≤ 4px in the first viewport; every status has an icon and a word; no text under 13px.
- **Fixtures**: the 5-hour fixture uses believable 5-hour forecasts; every state in `05-states.md` has a capture (adds: disconnected, refresh-failed phone, 5-hour 200-account).

## Decision log (locked)

Reviewers flip-flopped on these across rounds; the spec fixes each with a reason, and only a measured problem reopens one.

| Decision | Choice | Why |
|---|---|---|
| Headline label position | under the number, two lines | survives five-digit numbers on phones; one rule everywhere |
| Capacity wording | "of 300 points" | reads as a fraction; "N points total" read as a second total |
| Withheld headline | "—" + reason in label line 2 | an em dash is the standard missing-value mark when explained [R§2]; a word at display size read as data |
| Notice placement | card notice under the summary; page notice under the page header | notices qualify what's above them and never separate a control from its target [R§3] |
| Refresh action | page-level only (RefreshControl / PageStatus) | one refresh affordance [R§1]; card notices get "Show affected accounts" instead |
| Low bars | critical fill, neutral track, ⚠ icon | outline and tint both read as a second object; the icon carries meaning without colour |
| Group headings | one `type-section` style (13/18, 600, secondary) for every in-card and footer section | a section heading that is neither a label nor a title |
| Ready status | neutral "Forecast: Ready" chip, one shape for every state | reopened by council decision 1: 35 reviewer notes, none asking for removal; R§3 is about success messages, not status chips |
| Settings selects | inline, prefixed, one baseline; no popover | council decision 2: they change every card's numbers |
| Default accounts sort | Name A–Z | council decision 4b: stable across reloads; server order is meaningless |
| Stale rows | dim text and bars to the 3:1 limit, keep icons | dimming signals age without breaking contrast rules |

## Beyond this redesign (candidates, not in scope)

- Shared crosshair across cards; range presets (24h / 7d / 30d).
- "Notify me when below …" on the card menu.
- Keyboard shortcuts (`r` refresh, `w` window, `/` search).
- Density toggle for large rosters.
- Chart "View as table" (council decision 4d): a toggle button, reusing `analytics.table_alternative`.
