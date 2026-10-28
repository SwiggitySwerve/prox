# Compact account hillclimb continuation

Status: visual iteration stopped at 55/56; the best compact version (decimal round 4) is restored for the authorized deployment. Final local release checks passed; deployment is pending.

The user requested council assessment, continuation, and scores in 0.1 increments. The pass threshold remains 9.0. Historical integer ratings were not changed. Three independent reviewers first read the existing screenshot, then scored paired versions with counterbalanced order. New baseline ratings are separate assessments of the same pixels, not retroactive edits or evidence of a visual regression.

## Council findings

- Different hierarchy complaints were being treated as one problem. All three reading probes eventually interpreted the values correctly, but located extra tracing between the long name and its credits warning.
- Existing checks omitted nested text runs, tested compact interactions only on the first provider, and recorded height without enforcing it. They now sample visible text runs, exercise both providers, compare row/section heights and wrapping, and check local numeric alignment.
- Provider account crops also receive measurements, because the application scrolling pane can place content outside the full-page capture. The measurements remain rendered checks, not an axe or screen-reader audit.
- Two initial review descriptions incorrectly claimed the unavailable explanation moved. The reviewers corrected that description in the next round; their original ratings and statements remain preserved.

The [council decision](decision.md), cross-attack, verifier correction and reading probes are retained beside this report.

## Decimal rounds

H = hierarchy; L = layout; T = type/numbers; C = colour; Co = content; Ct = controls/states; Cs = consistency; A = responsive/accessibility. Changes compare the same reviewers’ paired ratings. Median values are not rounded up to a pass.

### Decimal round 1: 43 → 45/56 passing cells

[Images, raw reviews and measurements](../27-warning-inset/).

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 8.8 (+0.0) | 8.5 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| laptop | 8.8 (+0.0) | 8.9 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| narrow | 9.0 (+0.3) | 9.0 (+0.2) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.1 (+0.0) |
| long-narrow | 8.8 (+0.4) | 8.8 (+0.2) | 9.1 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| partial | 8.8 (+0.0) | 8.8 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| stale | 8.8 (+0.0) | 8.8 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| expanded | 9.2 (+0.0) | 8.8 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |

### Decimal round 2: 45 → 46/56 passing cells

[Images, raw reviews and measurements](../28-warning-rule/).

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 8.8 (+0.0) | 8.5 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| laptop | 8.8 (+0.0) | 8.9 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| narrow | 9.1 (+0.1) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.1 (+0.0) |
| long-narrow | 9.0 (+0.2) | 8.8 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| partial | 8.8 (+0.0) | 8.8 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| stale | 8.8 (+0.0) | 8.8 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| expanded | 9.2 (+0.0) | 8.8 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |

### Decimal round 3: 46 → 52/56 passing cells

[Images, raw reviews and measurements](../29-bounded-rows/).

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9.1 (+0.3) | 8.8 (+0.3) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| laptop | 9.1 (+0.3) | 8.9 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| narrow | 9.1 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.1 (+0.0) |
| long-narrow | 9.0 (+0.0) | 8.8 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| partial | 9.0 (+0.2) | 9.0 (+0.2) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| stale | 9.0 (+0.2) | 9.0 (+0.2) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| expanded | 9.2 (+0.0) | 8.9 (+0.1) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |

### Decimal round 4: 52 → 55/56 passing cells

[Images, raw reviews and measurements](../30-packed-rows/).

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9.1 (+0.0) | 9.1 (+0.3) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.3 (+0.1) | 9.0 (+0.0) |
| laptop | 9.1 (+0.0) | 9.2 (+0.3) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.3 (+0.1) | 9.0 (+0.0) |
| narrow | 9.1 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.1 (+0.0) |
| long-narrow | 9.0 (+0.0) | 8.8 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| partial | 9.0 (+0.0) | 9.2 (+0.2) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.0) | 9.2 (+0.0) | 9.3 (+0.1) | 9.0 (+0.0) |
| stale | 9.0 (+0.0) | 9.2 (+0.2) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.3 (+0.1) | 9.0 (+0.0) |
| expanded | 9.2 (+0.0) | 9.0 (+0.1) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |


### Decimal round 5: two spacing alternatives, both 55/56

[Measurements and images](../31-warning-tight/). All deltas are zero. The second spacing alternative is in [32-warning-space](../32-warning-space/); the three-way raw reviews are in `spacing-review-*.json`.

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9.1 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| laptop | 9.1 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| narrow | 9.1 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.1 (+0.0) |
| long-narrow | 9.0 (+0.0) | 8.8 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| partial | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| stale | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| expanded | 9.2 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |

### Decimal round 6: connector extension, 55/56

[Measurements and images](../33-warning-connector/). All deltas are zero. The second spacing alternative is in [32-warning-space](../32-warning-space/); the three-way raw reviews are in `spacing-review-*.json`.

| State | H | L | T | C | Co | Ct | Cs | A |
|---|---|---|---|---|---|---|---|---|
| wide | 9.1 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| laptop | 9.1 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| narrow | 9.1 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.1 (+0.0) |
| long-narrow | 9.0 (+0.0) | 8.8 (+0.0) | 9.1 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |
| partial | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.4 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| stale | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.0 (+0.0) |
| expanded | 9.2 (+0.0) | 9.0 (+0.0) | 9.2 (+0.0) | 9.2 (+0.0) | 9.3 (+0.0) | 9.3 (+0.0) | 9.2 (+0.0) | 9.0 (+0.0) |

## Preservation and verification

All completed candidate capture runs pass the eight-state checks. Both providers preserve complete names, balances, warning text, unavailable/stale meaning and keyboard expansion/restoration. No measured section or row grew, and no name or warning gained a line. Expanded account layouts are unchanged. Minimum sampled text contrast is 5.56:1; warning grouping rules are 5.37:1, against unchanged 4.5:1 text / 3:1 meaningful non-text thresholds.

Final restored `bun run verify` passed: 1,964 tests, zero failures; lint zero errors with six existing Fast Refresh warnings; TypeScript and frontend/history builds passed. Targeted formatting, Python syntax and diff checks passed. All 24 restored account crops are byte-identical to decimal round 4. The eight restored capture states pass, with both-provider interactions and no growth or extra wrapping. No new candidate has yet been deployed.

Review paths under `/tmp/prox-compact-pairs` map A/B to `26-council-baseline` / `27-warning-inset`; `/tmp/prox-compact-round2` maps to `27-warning-inset` / `28-warning-rule`; round3 maps to `28-warning-rule` / `29-bounded-rows`; round4 maps to `29-bounded-rows` / `30-packed-rows`. Raw reviews are preserved without rewriting their descriptions.

## Decision after the plateau

Both the spacing comparison and connector comparison failed to improve the best 55/56 count. All three reviewers reported no meaningful preference for these extra tweaks. They are discarded. The remaining long-name mobile layout median is 8.8, with suggestions still divided between tighter grouping and more vertical room. No score has been raised or waived, and the 56/56 hillclimb completion target is **not met**.

The user previously selected “Keep the compact layout and finish deployment.” That standing release direction governs the best verified compact improvements. This release is not being called completion of the all-cells visual goal. An optional follow-up asks whether future work may add height to long-name rows; the existing compact preference remains the default.

The restored version retains the shared closed-account grid, bounded label/value spans, warning indentation and short rules. It removes both spacing alternatives and the rule extension. The accepted UI changes are presentation-only; no provider, auth, quota arithmetic, inference routing or catalog behavior changes.

Round 5 review paths `/tmp/prox-compact-spacing/{A,B,C}` map to rounds 30/31/32. Round 6 `/tmp/prox-compact-round6/{A,B}` maps to rounds 30/33. Restored release captures are in [34-restored-compact](../34-restored-compact/).
