**[ITERATE]**

**Summary:** E is executable after its acceptance protocol is specified; begin with A’s diagnosis before attempting B. The evidence supports two competing explanations—window interpretation and warning grouping—not a demonstrated shared reading failure.

**Issues**

1. **E needs a comparison rule that prevents decimal scores from becoming evidence of improvement by themselves.** I verified that all 24 restored account crops are byte-identical to round 22. A higher score on those same pixels would establish review variation, not UI improvement. Keep historical integers untouched; record new baseline/candidate assessments separately in 0.1 increments, using the same reviewers, rubric and paired screenshots. Require an observable explanation for score changes. Retain the existing seven-state, eight-aspect matrix and **9.0 median threshold in every cell**; do not round 8.9 into a pass. The [historical record](/home/swerve/src/prox/docs/evidence/hillclimb/compact-accounts-and-stacked-charts.md) confirms 55/56, then 44/56 and 33/56.

2. **A/B/E need one falsifiable reading task before choosing the correction.** [Reviewer 2](/home/swerve/src/prox/docs/evidence/hillclimb/22-account-readable/review-2.json) requests local window qualifiers; [reviewer 3](/home/swerve/src/prox/docs/evidence/hillclimb/22-account-readable/review-3.json) requests clearer name/warning grouping. Neither records an actual misidentification.

   The smallest useful screenshot test asks reviewers, independently and before scoring, to identify the complete first account name, what **82.8%** measures, which account owns **0% credits**, and why account 2 shows both **—** and **14%**. Expected answers: weekly remaining; first account’s credits; unavailable weekly quota alongside available five-hour remaining quota. Record incorrect answers or the specific association requiring rereading, then repeat against the candidate.

   **B survives** if grouping is the observed difficulty. **C survives** if window identification fails; its labels must also follow the selected window. **D has no demonstrated execution blocker**, but no evidence currently requires its broader scope. Historical suggestions to shorten names are inadmissible under this brief.

3. **B–E need explicit preservation checks beyond a clean capture summary.** I inspected all four long-name versions: round 24 visibly separates “Exhausted” from “0% left”; its measured long-name section grows from **282.8px to 299.6px**, despite zero reported mechanical failures. Its expanded screenshot also confirms the bright empty-track regression.

   Use the existing [Playwright capture script](/home/swerve/src/prox/scripts/visual/prox-quota-capture.py:319) across all eight existing capture states, including expanded mobile, and inspect both providers. Acceptance must require full visible names, unchanged balances and warning ownership, correct unavailable/stale meaning, preserved provider colours, passing existing mechanical checks, and a stated compact-height bound against the restored measurements. The script’s compact interaction assertions currently target the **first provider**, so repeat keyboard expansion/restoration checks for the second. If C changes window labels, additionally exercise weekly → five-hour → weekly with distinguishable fixture values.

These are directly patchable acceptance gaps. No missing user decision or new testing framework blocks the work.
