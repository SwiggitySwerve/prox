# Prox quota visual review

Target: the quota dashboard in the supplied Prox reference, using this fork's
existing Claude orange, Codex blue, dark surfaces and provider icons. Quota
calculation, account routing, authentication and collection stay unchanged.

## Fixed checks

These thresholds are set before the baseline and remain fixed across rounds:

- Rendered text contrast: 4.5:1; large text: 3:1.
- Meaningful chart strokes: 3:1 against the rendered chart background.
- Claude orange: hue 10–35°, saturation at least 0.4.
- Codex blue: hue 205–235°, saturation at least 0.4.
- Provider hues: circular separation at least 120°.
- Controls: at least 24×24 CSS px; 44×44 on touch.
- No page or component horizontal scrolling, clipped labels or status text.

The capture script uses Chromium with fixed viewports, UTC, English, dark mode
and reduced motion. It runs the actual Vite application with synthetic API
responses. These fixtures test presentation states; they are not evidence of
live balances or forecasting accuracy. The script never reads production keys.
Text and provider colours are sampled from screenshots; DOM measurements supply
geometry and typography thresholds only. Small antialiased glyphs may need
manual pixel inspection; the raw per-element readings are retained.

Run from the repo with Vite on loopback port 15173:

```sh
uv run --with playwright --with pillow python scripts/visual/prox-quota-capture.py --round baseline
```

Reviewers score each captured state on hierarchy, layout, type/numbers, colour,
content, controls/states, consistency and responsive/accessibility. Screenshots
and measurements are captured again with the same script for each round.

## Round 2 verification

Reduced plot height and card spacing, restored remaining/capacity context in rate
views, placed point normalization beside the controls, and qualified saved data
after refresh failures. Forecasts that cannot be calculated say “Unavailable”;
the projected legend appears only when the rendered series contains projections.
The initial chart sample now has a visible value and matching marker. Initial
loading, empty and error states disable controls that need loaded data.

All 14 captures pass the fixed checks: minimum sampled text contrast 8.19:1,
Claude/Codex strokes 8.48:1 and 8.51:1, hues 16.8°/219.7° (157.1° separation),
and minimum active targets 24px desktop / 44px touch. No measured overflow,
clipped text, browser exceptions or failed colour checks. The capture now
recognizes text inside disabled buttons as disabled, matching the existing
inactive-control contrast exemption; the thresholds are unchanged.

`bun run verify` passed: 1,726 tests, ESLint, TypeScript, the single-file frontend
build and the server bundle. The screenshots use synthetic API fixtures and do
not establish production quota correctness. The T3 inline HTML preview was
blocked by the host's AppArmor browser sandbox; isolated Chromium captured the
actual app. Three independent visual reviews produced 52/112 passing cells,
up from 35/112 in round 1 and 7/112 at baseline. No reviewer spread reached
three points. Laptop type/numbers and responsive/accessibility medians each
dropped from 9 to 8 because of wrapping; round 3 addresses that regression.

## Round 3 verification

Laptop statistics use two columns, the mobile Accounts link shares the title
row, and supporting labels are larger. Chart sample readouts sit beside their
keyboard controls. Empty/loading/error panels have clearer headings; unavailable
forecasts have local chart captions. Account percentages explicitly say Remaining,
and stale rows display the actual observation time. The empty-state credential
action goes to the existing OAuth login screen.

The collector sets `lastRefreshAtMs` in its `finally` block, including failed
collections. The UI therefore calls it **Last collection attempt**, not Last
successful refresh. Dashboard polling and collection availability have separate
labels. No backend or quota calculation changed.

Fixture corrections are not UI improvements: the previous long-label fixture
combined a missing required window with a ready aggregate; it now retains the
missing-window row and withholds aggregate/projection values, matching
`server/quota/domain.ts`. Partial/stale/collecting fixtures no longer invent
projection reset markers, and the stale example preserves its older observed
percentage while withholding the current aggregate. Account counts, ordinary
ready-state balances and the 14 capture cases remain the same. Compare the
affected screenshots with this data correction in mind.

All 14 states pass the fixed measured checks. Sampled text contrast remains at
least 8.19:1, Claude/Codex strokes 8.48:1/8.51:1, and active control minimums
24px desktop / 44px touch. The first chart SVG moved up 74.5px on laptop and
103px on phone compared with round 2. There are no measured clipping, overflow,
colour or browser-error failures.

The capture script also checks keyboard sample selection and agreement between
visible/accessible readouts, the single-sample state without an inert slider,
disabled unavailable controls, and the empty-state credential destination.
Every state has a passing applicable interaction check recorded in
`round-3/measurements.json`. These are synthetic browser checks, not live provider
verification. Independent visual scores for round 3 are pending.

Final round-3 `bun run verify` passed: 1,726 tests, ESLint, TypeScript and both
production builds. Targeted Prettier validation and `git diff --check` also pass.
