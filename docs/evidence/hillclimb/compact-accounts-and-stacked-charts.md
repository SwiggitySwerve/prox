# Compact accounts and stacked provider charts

Status: the best visual round is deployed at `8d6905416b3810433ced35e27a46b27227a197f0` on 2026-10-28. The user selected the compact layout and then reopened the hill climb with a council assessment. Only Prox UI and history restarted; inference proxies and the separate usage dashboard were unchanged.

## Implemented

- Combined usage defaults to stacked provider bands, with separate provider lines available. Band thickness and inspection values retain each provider’s contribution; forecasts preserve independent resets and missing-data gaps.
- The history service supplies aligned provider layers without account metadata. Quota arithmetic remains server-owned.
- Minimized account rows retain names, selected-window balances and low/missing/stale warnings. Expansion reveals plans, all limits and reset details.
- Smaller outlined controls, readable disclosure icons, clearer selected-window headings and aligned stale values preserve the existing dark design.

## Visual review

Three independent screenshot reviewers assessed seven account states per round. H=hierarchy, L=layout, T=type/numbers, C=colour, Co=content, Ct=controls/states, Cs=consistency, A=responsive/accessibility. Cells use the median. Changes below compare recorded medians between rounds, not each new reviewer’s retrospective baseline rating.

### Round 1: 22/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9 (+2) | 9 (+2) | 9 (+0) | 8 (-1) | 6 (-1) | 7 (-1) | 8 (-1) | 8 (-1) |
| laptop | 9 (+2) | 9 (+3) | 9 (+0) | 8 (-1) | 6 (-1) | 7 (-1) | 8 (-1) | 8 (+0) |
| narrow | 9 (+2) | 9 (+4) | 9 (+1) | 8 (-1) | 6 (-1) | 8 (+0) | 9 (+0) | 8 (+1) |
| long-narrow | 9 (+2) | 9 (+4) | 9 (+1) | 8 (-1) | 6 (-1) | 8 (+0) | 9 (+0) | 8 (+1) |
| partial | 9 (+2) | 9 (+3) | 9 (+0) | 8 (-1) | 6 (-1) | 7 (-1) | 8 (+0) | 8 (+0) |
| stale | 8 (+1) | 9 (+3) | 9 (+0) | 8 (-1) | 6 (-1) | 7 (-1) | 8 (+0) | 8 (+0) |
| expanded | 9 (+0) | 8 (+0) | 8 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 8 (+0) | 8 (-1) |

[Screenshots and individual reviews](18-account-compact/).

### Round 2: 47/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+3) | 9 (+2) | 9 (+1) | 9 (+1) |
| laptop | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+3) | 9 (+2) | 9 (+1) | 9 (+1) |
| narrow | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+3) | 9 (+1) | 9 (+0) | 8 (+0) |
| long-narrow | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+3) | 9 (+1) | 9 (+0) | 8 (+0) |
| partial | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+3) | 9 (+2) | 9 (+1) | 9 (+1) |
| stale | 8 (+0) | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+3) | 9 (+2) | 8 (+0) | 9 (+1) |
| expanded | 9 (+0) | 9 (+1) | 8 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+1) | 8 (+0) |

[Screenshots and individual reviews](19-account-warnings/).

### Round 3: 53/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| laptop | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| narrow | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) |
| long-narrow | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) |
| partial | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |
| stale | 8 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+1) | 9 (+0) |
| expanded | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) |

[Screenshots and individual reviews](20-account-aligned/).

### Round 4: 47/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| laptop | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| narrow | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| long-narrow | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| partial | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) |
| stale | 9 (+1) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+1) | 8 (-1) | 9 (+0) |
| expanded | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |

[Screenshots and individual reviews](21-account-final/).

### Round 5: 55/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| laptop | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| narrow | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| long-narrow | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| partial | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) |
| stale | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) |
| expanded | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) |

[Screenshots and individual reviews](22-account-readable/).

### Round 6: 44/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |
| laptop | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |
| narrow | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |
| long-narrow | 9 (+1) | 9 (+0) | 8 (-1) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |
| partial | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |
| stale | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 8 (-1) | 9 (+0) | 9 (+0) |
| expanded | 9 (+0) | 9 (+0) | 9 (+0) | 8 (-1) | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) |

[Screenshots and individual reviews](23-account-hierarchy/).

### Round 7: 33/56 passing cells

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 8 (-1) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) |
| laptop | 8 (-1) | 7 (-2) | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+0) | 8 (-1) | 8 (-1) |
| narrow | 8 (-1) | 7 (-2) | 8 (-1) | 9 (+0) | 9 (+1) | 9 (+0) | 8 (-1) | 8 (-1) |
| long-narrow | 8 (-1) | 7 (-2) | 8 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 8 (-1) | 8 (-1) |
| partial | 8 (-1) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+0) | 9 (+0) | 9 (+0) |
| stale | 8 (+0) | 9 (+0) | 9 (+0) | 9 (+0) | 9 (+1) | 9 (+1) | 9 (+0) | 9 (+0) |
| expanded | 8 (-1) | 9 (+0) | 9 (+0) | 7 (-1) | 8 (+0) | 7 (-2) | 7 (-2) | 9 (+0) |

[Screenshots and individual reviews](24-account-meaning/).

The best round was round 5: **55/56 cells**, with only long-name mobile hierarchy at 8. Subsequent rounds scored 44 and 33; two consecutive rounds failed to exceed the best count. The requested skill requires stopping and asking for direction at that point. Round 7 also produced a three-point reviewer spread for expanded-state colour. Its warning wrapping and bright empty-track regressions were discarded.

The final account captures in `25-restored-best` are byte-for-byte identical to round 5 across all 24 account crops, including both providers and expanded mobile. No further subjective review round was run after restoring that state.

## Measured checks and interactions

- Browser fixtures render the actual application with synthetic transport; they do not prove production compatibility.
- All eight restored states: zero horizontal overflow, clipped text, target failures, contrast failures, semantic-colour failures or page errors.
- Thresholds held throughout: 4.5:1 text, 3:1 large text and meaningful non-text; 24px desktop and 44px touch targets; orange hue 10–35°, blue 205–235°, hue separation at least 120°.
- Minimum measured text contrast: 7.6:1. Measured provider hue separation: 157.1°.
- Verified closed low-limit visibility, retained unavailable/stale states, keyboard Enter expansion, and full-card restoration.
- Account heights, baseline → restored: wide 170.4 → 97.9px; mobile 585.8 → 219.8px.
- The separate stacked-chart capture suite covers twelve states with zero measured failures.

## Validation and release boundary

- Full `bun run verify`: 1,964 tests passed, zero failed; TypeScript and production frontend/history builds passed. ESLint: zero errors, six existing Fast Refresh warnings.
- Targeted Prettier checks, Python syntax checks and `git diff --check` passed.
- A consistent private SQLite backup and rollback image tags were prepared before deployment. Both deployed image revision labels match `8d69054`; both services are active and Nginx configuration passed validation.
- Authenticated loopback browser checks against the deployed UI and real cached quota data passed: stacked contributions match the total, both chart views, filters/rate mode, minimize/restore, keyboard inspection and account expansion. Five accounts were visible. Mobile overflow was false; there were no page errors or reported issues. Screenshots were personally inspected. Public SSO remains unverified.
- Live account-section heights fell from 178.6/239.1px to 78.0/118.8px when minimized. Service start-time comparison confirmed the inference proxies and usage dashboard were unchanged.
- Local release evidence: `/tmp/prox-live-stacked/results.json` and `/tmp/prox-live-stacked/{stacked-desktop,stacked-minimized,stacked-mobile}.png`. These live captures remain local; committed visual fixtures use synthetic account data.
- No PR was created: the user explicitly requested direct commits for this work.

## Screenshots

[Baseline mobile account section](17-account-baseline/narrow-accounts.png) · [Restored mobile account section](25-restored-best/narrow-accounts.png) · [Restored desktop](25-restored-best/wide.png) · [Stacked chart](16-stacked/stacked-wide.png)
