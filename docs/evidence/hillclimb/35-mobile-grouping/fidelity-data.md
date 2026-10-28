# Prox compact mobile grouping fidelity review

recommendation: REQUEST_CHANGES

## Scope and decision

B offers a small visual reading benefit for long mobile account names. Its faint surface encloses the full name, weekly value, and supplemental warning before the next account begins. Long-narrow hierarchy improves from 8.9 to 9.0 and layout from 8.8 to 9.0. All other screenshot scores retain the authorized prior A baseline. There are no score drops. This is a qualitative judgment, with moderate confidence in the grouping benefit; it is not a measured speed or accuracy improvement.

Design-system approval is blocked by new hardcoded styling in the current source diff. The visual benefit can be retained while fixing the token ownership.

Goal: independently assess account and quota attribution in A versus B, preserving the dark design, provider colors, full account names, and compact heights. Success criteria: answer all four reading tasks, inspect both providers across seven states, cross-check expanded narrow and full long-narrow, explain every score below 9 and every score change, and distinguish visible fidelity from implementation evidence.

Reference/target: the supplied A and B screenshot directories under `/tmp/prox-compact-round7`. A is the unchanged visual baseline; B introduces compact mobile summary surfaces. No separate design specification, immutable screenshot-to-revision mapping, or notepad path was supplied. The current unstaged source diff is consistent with the visible change, but that consistency does not prove capture provenance.

## Findings by severity

### CRITICAL

None identified in the inspected evidence. The inspected account rendering uses real elements, not a screenshot replacement. This statement is scoped to the source inspected; screenshots alone do not establish live behavior.

### HIGH

**H1 — New mobile summary styling bypasses design tokens.** `src/features/quotaPool/QuotaPoolPage.module.scss:1159` adds `background: #191919`; line 1162 adds hover `background: #202020`; line 1160 adds a literal `4px` radius. These are local appearance decisions rather than consumption of centrally owned tokens. `src/styles/themes.scss:4` explicitly calls for tokens instead of feature-local colors, and line 14 already owns the `#202020` secondary-surface value.

Required correction: use centrally owned semantic tokens for the resting surface, hover surface, and radius, preserving the reviewed dark shades, full names, provider colors, and compact geometry. Add a centrally owned token where an appropriate existing token does not exist. Do not change the visual target merely to choose a different existing shade. This is an implementation blocker, not a reason to distort the independently assigned screenshot colour scores.

### MEDIUM

**M1 — Coverage wording remains ambiguous in stale views, in both variants.** The Claude header says “2 loaded · 3 eligible” while all three rows show percentages; Codex says “1 loaded · 2 eligible” while both rows show percentages. The Stale qualifier and observation timestamp are clear, but the count label does not explain why a visibly populated row is excluded. Both stale content scores remain 8.8. The coverage output is at `src/features/quotaPool/PoolCard.tsx:202`.

Required visual correction: replace “loaded” with “current” in the coverage label, keeping the count and line footprint, and retain each stale label and timestamp. This is an unchanged baseline issue, not a regression introduced by B.

**M2 — A still requires extra boundary tracing for the first long Claude name and credits warning.** In `A/long-narrow-provider-0-accounts.png`, the three-line name and Cloud Session Credits 0% rely on indentation and a separator to communicate ownership. A hierarchy remains 8.9 and layout 8.8. B's continuous summary surface provides the missing enclosure without moving the text. If A is retained, apply an equivalent token-driven enclosure within the current geometry. B addresses this visual issue.

### LOW

No additional actionable finding. Native summary controls, focus behavior, screen-reader semantics, and measured contrast were not exercised. Accessibility scores describe visible presentation only.

## Component, token, and layout evidence

- `src/features/quotaPool/QuotaPoolPage.tsx:254` maps provider data into the reused `PoolCard` component.
- `src/features/quotaPool/PoolCard.tsx:223` maps accounts through one shared rendering path using `details` and `summary`; lines 237, 259, and 268 render account text, weekly values, and a nested list of limits. There is no raster substitute in this inspected account subtree.
- Names, primary percentages, status explanations, and supplemental limits share the summary parent. The new CSS selects collapsed summaries inside minimized provider cards at mobile width, matching the grouping visible in B. Expanded Claude remains unchanged; collapsed Codex still gains the surface in the expanded-narrow cross-check.
- The inspected source change adds backgrounds and a radius, with no new padding or height. The images show no apparent compact-height increase. No mechanical layout or browser test was run.
- The stylesheet consumes theme tokens elsewhere, but H1 shows that this addition does not. Existing unrelated literal styles were not exhaustively audited.

## Changed files and inspected diff

`git diff --stat -- src` reported one changed source file with nine added lines: `src/features/quotaPool/QuotaPoolPage.module.scss`. The complete current unstaged source diff for that file was inspected:

```diff
@@ -1154,6 +1154,15 @@
       min-height: 44px;
     }
   }
+  @media (max-width: 640px) {
+    .account:not([open]) > summary {
+      background: #191919;
+      border-radius: 4px;
+      &:hover {
+        background: #202020;
+      }
+    }
+  }
   @media (min-width: 1200px) {
     .accountGrid:not(:has(.account[open])) {
       grid-template-columns: repeat(3, minmax(0, 1fr));
```

## Reading and evidence limits

Both variants expose the complete first long account name: “A deliberately long credential label for a shared development workstation”. 82.8% is Claude account 1's weekly quota remaining. Cloud Session Credits 0% belongs to that same account. In long-narrow, account 2's dash means unavailable weekly quota; 14% is its separately labelled five-hour remaining quota. Confidence in these answers is high.

Every requested pair was opened B then A using `view_image`. All 36 unique requested screenshots were inspected, including the combined expanded-narrow account crops; full long-narrow images were also reopened at original detail. Only after those inspections was the explicitly authorized prior data-lens report read to calibrate unchanged A scores. No other reviewer files were read, no delegation occurred, no app changes were made, and no browser or mechanical checks were claimed. The generated score JSON was parsed and its state, aspect, and score structure validated.

The screenshot review is at `docs/evidence/hillclimb/35-mobile-grouping/review-data.json`. The separate fidelity artifact is required by the review role despite the user's narrower single-artifact preference.

## Blockers before approval

1. Resolve H1 by moving the new surface and radius decisions into the shared token system while preserving B's reviewed appearance.
2. Supply screenshot-to-revision provenance for final implementation approval; the current source and supplied screenshots are consistent but not independently bound to the same build.

M1 remains the visual content issue in both variants; M2 is the grouping issue specific to A. No misleading prior success claim was used as evidence.

## Artifacts inspected

- `/tmp/prox-compact-round7/B/wide-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/wide-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/wide-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/wide-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/laptop-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/laptop-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/laptop-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/laptop-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/narrow-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/narrow-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/narrow-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/narrow-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/long-narrow-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/long-narrow-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/long-narrow-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/long-narrow-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/partial-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/partial-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/partial-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/partial-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/stale-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/stale-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/stale-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/stale-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/expanded-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/expanded-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/expanded-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/expanded-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/expanded-narrow-provider-0-accounts.png`
- `/tmp/prox-compact-round7/A/expanded-narrow-provider-0-accounts.png`
- `/tmp/prox-compact-round7/B/expanded-narrow-provider-1-accounts.png`
- `/tmp/prox-compact-round7/A/expanded-narrow-provider-1-accounts.png`
- `/tmp/prox-compact-round7/B/expanded-narrow-accounts.png`
- `/tmp/prox-compact-round7/A/expanded-narrow-accounts.png`
- `/tmp/prox-compact-round7/B/long-narrow.png`
- `/tmp/prox-compact-round7/A/long-narrow.png`
- `/home/swerve/src/prox/docs/evidence/hillclimb/33-warning-connector/review-data.json`
- `/home/swerve/src/prox/src/features/quotaPool/QuotaPoolPage.module.scss`
- `/home/swerve/src/prox/src/features/quotaPool/PoolCard.tsx`
- `/home/swerve/src/prox/src/features/quotaPool/QuotaPoolPage.tsx`
- `/home/swerve/src/prox/src/styles/themes.scss`
