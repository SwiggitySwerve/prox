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
