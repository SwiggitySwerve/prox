# Analytics responsive review

Branch: `feat/analytics-compact-chrome`. Base: `main` (`757d9c9`).

This continues the compact Analytics layout and adds the requested removal of the cloud-session credit indicator and an outlined Refresh/Language/Logout bar. Captures use synthetic data and the real application shell; they do not establish production backend behavior.

## Round 9

Three independent reviewers: layout, data/content, and interaction/accessibility. **57/80** median cells meet 9/10. No aspect has a reviewer spread of 3 points or more. This is the first scored round of the resumed responsive work; earlier Analytics redesign rounds covered a different scope.

| Screen | Hierarchy | Layout | Type | Colour | Content | Controls | Consistency | Responsive |
|---|---|---|---|---|---|---|---|---|
| overview | 9 | 8.2 | 9 | 9.2 | 9 | 9 | 9 | 8 |
| tokens | 8.5 | 8 | 9 | 8.4 | 8.5 | 9 | 9 | 8 |
| cost | 9 | 8.8 | 9.2 | 9.3 | 8.7 | 9 | 9 | 9 |
| performance | 8.8 | 8.4 | 9 | 9 | 8 | 9 | 9 | 8.5 |
| requests | 9 | 8.5 | 9 | 9.2 | 9 | 9 | 8.8 | 9 |
| rates | 9 | 8.6 | 9 | 9.2 | 8.8 | 9 | 8.8 | 8.7 |
| empty | 9.2 | 9 | 9 | 9 | 9.2 | 9 | 9 | 9 |
| unknown | 8.8 | 8.6 | 9 | 9 | 8.6 | 9 | 9 | 8.7 |
| error | 9.3 | 9 | 9 | 9.3 | 9 | 9.3 | 9.1 | 9.1 |
| loading | 9 | 9 | 9 | 9 | 9 | 9 | 9 | 9 |

Source scores: [layout](r9-layout.json), [data](r9-data.json), [interaction](r9-interaction.json).

The saved r9 measurements passed 40 full-content captures. Expanded r9 coverage passed 116 initial-viewport/full-content captures across 13 sizes, but stronger chart-visibility tests then failed: Overview ended at 875.78px in a 1280×720 viewport and 913.78px in a 1024×768 viewport. This distinction matters: passing overflow checks did not imply that a chart was visible on load.

## Round 10 verification

All nine desktop chart-visibility cases pass for Overview and Tokens, from 1024×768 through 3440×1440. All 13 sizes pass filter/card fit and target checks. The complete browser run passes 91 cases, comprising 33 interaction/layout cases and 58 capture cases. The final toolbar change was then recaptured across all 58 cases. A dedicated 1024px touch context verifies 44px targets and keyboard access to Measurement details.

The measurement report covers 116 images: [failures](../analytics-r10/measurements.json), [numeric values](../analytics-r10/measurement-values.json). Minima: text contrast 5.23:1; series contrast 8.05:1; distinct series ΔE 34.24; toolbar-border contrast 5.37:1. Target minima are 24px desktop and 44px touch-width layouts. Horizontal overflow and detected clipped elements are zero. The checks sample painted text/legend pixels and DOM geometry; they are not a complete accessibility audit.

The full `bun run verify` run passes 1,995 tests, lint (six existing warnings), frontend/server TypeScript and production builds. Browser TypeScript and targeted formatting pass. The cloud-credit change has four updated regression cases that failed before implementation; 31 focused Claude tests pass, followed by 44 collector/dashboard tests. The collector fixture includes exhausted cloud credits and asserts that only real quota windows reach account metadata.

Cloud credits are excluded in the shared quota-window owner, which is used by both the credential UI and history collector. Deployment must include the server artifact for the pooled account display to update. This work has not been deployed.

The screenshot tool expands viewport height for full-content images; use the matching `fold/` image for initial viewport and height-dependent layout judgments.

Round 10: **74/80** median cells meet 9/10. No reviewer spread reaches 3 points. The six remaining cells concern Overview/Tokens hierarchy, layout and responsiveness at 320×568, where expanded filters hide all KPI values below the fold. The lower hierarchy ratings reflect the newly reviewed 320px case; all reviewers report no visual regression in compared layouts.

Source scores: [layout](r10-layout.json), [data](r10-data.json), [interaction](r10-interaction.json).

| Screen | Hierarchy | Layout | Type | Colour | Content | Controls | Consistency | Responsive |
|---|---|---|---|---|---|---|---|---|
| overview | 8 (-1.0) | 8.7 (+0.5) | 9.2 (+0.2) | 9.2 (+0.0) | 9.1 (+0.1) | 9 (+0.0) | 9.2 (+0.2) | 8 (+0.0) |
| tokens | 8 (-0.5) | 8.7 (+0.7) | 9.1 (+0.1) | 9.2 (+0.8) | 9.3 (+0.8) | 9 (+0.0) | 9.2 (+0.2) | 8 (+0.0) |
| cost | 9.2 (+0.2) | 9.1 (+0.3) | 9.3 (+0.1) | 9.4 (+0.1) | 9.2 (+0.5) | 9 (+0.0) | 9.2 (+0.2) | 9 (+0.0) |
| performance | 9.1 (+0.3) | 9.1 (+0.7) | 9.2 (+0.2) | 9.2 (+0.2) | 9.2 (+1.2) | 9 (+0.0) | 9.2 (+0.2) | 9 (+0.5) |
| requests | 9.1 (+0.1) | 9.1 (+0.6) | 9.2 (+0.2) | 9.2 (+0.0) | 9.3 (+0.3) | 9.2 (+0.2) | 9.2 (+0.4) | 9.1 (+0.1) |
| rates | 9.1 (+0.1) | 9.1 (+0.5) | 9.2 (+0.2) | 9.2 (+0.0) | 9.3 (+0.5) | 9.1 (+0.1) | 9.1 (+0.3) | 9.1 (+0.4) |
| empty | 9.2 (+0.0) | 9.1 (+0.1) | 9.2 (+0.2) | 9.2 (+0.2) | 9.3 (+0.1) | 9 (+0.0) | 9.2 (+0.2) | 9 (+0.0) |
| unknown | 9.1 (+0.3) | 9.1 (+0.5) | 9.2 (+0.2) | 9.2 (+0.2) | 9.3 (+0.7) | 9 (+0.0) | 9.2 (+0.2) | 9 (+0.3) |
| error | 9.3 (+0.0) | 9.2 (+0.2) | 9.2 (+0.2) | 9.3 (+0.0) | 9.2 (+0.2) | 9.3 (+0.0) | 9.2 (+0.1) | 9.1 (+0.0) |
| loading | 9 (+0.0) | 9 (+0.0) | 9.1 (+0.1) | 9.1 (+0.1) | 9 (+0.0) | 9 (+0.0) | 9.1 (+0.1) | 9 (+0.0) |

## Round 11

Phone filters start collapsed while preserving the selected range and active-filter count in a visible summary. At 320, 390 and 600px, the first KPI is visible in a 568px-high viewport; Enter/Space toggle the panel, active filters and unsubmitted search survive, and resizing to desktop always exposes the controls. The final browser suite passes **94/94** cases (36 interaction/layout cases and 58 capture cases). Six expanded-filter screenshots bring the measured image count to **122/122 passing**. Pixel minima remain text 5.23:1, series 8.05:1 and toolbar outline 5.37:1; overflow and detected clipping remain zero. The final `bun run verify` passes 1,995 tests, lint with six pre-existing warnings, both TypeScript builds and production builds. Browser TypeScript, focused tests, formatting and diff checks pass. Three independent screenshot reviews give **80/80** cells a median of at least 9/10. No measured check fails, no reviewer spread reaches 3 points, and no material regression is reported. The 0.1-point Requests/Rates layout drops are review variation: those desktop tables did not change in round 11. One reviewer still prefers tighter ultrawide table spacing (Requests 8.8, Rates 8.9); the medians pass. Keyboard and target-size claims come from the browser checks, not these screenshot reviews.

Source scores: [layout](r11-layout.json), [data](r11-data.json), [interaction](r11-interaction.json).

| Screen | Hierarchy | Layout | Type | Colour | Content | Controls | Consistency | Responsive |
|---|---|---|---|---|---|---|---|---|
| overview | 9.3 (+1.3) | 9.2 (+0.5) | 9.2 (+0.0) | 9.3 (+0.1) | 9.2 (+0.1) | 9.1 (+0.1) | 9.4 (+0.2) | 9 (+1.0) |
| tokens | 9.2 (+1.2) | 9.2 (+0.5) | 9.2 (+0.1) | 9.3 (+0.1) | 9.3 (+0.0) | 9.1 (+0.1) | 9.4 (+0.2) | 9 (+1.0) |
| cost | 9.3 (+0.1) | 9.2 (+0.1) | 9.3 (+0.0) | 9.4 (+0.0) | 9.4 (+0.2) | 9.1 (+0.1) | 9.4 (+0.2) | 9.1 (+0.1) |
| performance | 9.2 (+0.1) | 9.2 (+0.1) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.1) | 9.1 (+0.1) | 9.3 (+0.1) | 9 (+0.0) |
| requests | 9.2 (+0.1) | 9 (-0.1) | 9.2 (+0.0) | 9.3 (+0.1) | 9.4 (+0.1) | 9.2 (+0.0) | 9.3 (+0.1) | 9.2 (+0.1) |
| rates | 9.2 (+0.1) | 9 (-0.1) | 9.2 (+0.0) | 9.3 (+0.1) | 9.4 (+0.1) | 9.1 (+0.0) | 9.3 (+0.2) | 9.2 (+0.1) |
| empty | 9.3 (+0.1) | 9.2 (+0.1) | 9.3 (+0.1) | 9.2 (+0.0) | 9.4 (+0.1) | 9.1 (+0.1) | 9.4 (+0.2) | 9.1 (+0.1) |
| unknown | 9.2 (+0.1) | 9.2 (+0.1) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.1) | 9.1 (+0.1) | 9.3 (+0.1) | 9.1 (+0.1) |
| error | 9.4 (+0.1) | 9.3 (+0.1) | 9.3 (+0.1) | 9.4 (+0.1) | 9.3 (+0.1) | 9.3 (+0.0) | 9.3 (+0.1) | 9.2 (+0.1) |
| loading | 9.1 (+0.1) | 9.2 (+0.2) | 9.2 (+0.1) | 9.2 (+0.1) | 9.1 (+0.1) | 9 (+0.0) | 9.3 (+0.2) | 9.1 (+0.1) |

Final screenshots: [3440×1440 overview](../analytics-r11/fold/overview-3440x1440.png), [1280×720 tokens](../analytics-r11/fold/tokens-1280.png), [320×568 overview](../analytics-r11/fold/overview-320.png), [expanded phone filters](../analytics-r11/expanded/overview-320.png). Before/after phone comparisons use r10/r11 folds at the same sizes.

Final measurements: [failures](../analytics-r11/measurements.json), [values](../analytics-r11/measurement-values.json). No live backend verification or deployment was performed.
