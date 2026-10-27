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
actual app. Three independent visual reviews remain pending for this round.
