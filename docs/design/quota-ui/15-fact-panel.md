# Account facts panel and billing

Council decision: use a self-styled `FactPanel` primitive for read-only account facts, starting with the Quota Management inline drawer. Ship in two PRs. The auth-file edit sheet stays a form.

## Decision

`FactPanel`, `FactSection` and `Fact` own their styles. A class-map extension cannot unify the existing fact formats because the quota chip class block is frozen and serves two hosts.

- Facts use `dl > div > dt + dd`.
- Each fact explicitly declares a state: known; estimated with a required visible basis; not reported with a required visible reason; or not applicable with a required reason.
- “Estimated” and “Not reported” are visible words. Critical context never depends on a tooltip or an em dash.
- Exception (S7): on the Quota Management page each estimated renewal says “Estimated · from start date”, and one caveat per provider Accounts section carries “annual plans differ”. Other pages keep the full basis sentence.
- Section titles sit above facts. An optional header action includes visually hidden account context. Its `aria-describedby` points to the always-visible section note.
- The panel has no border or background. At most one section has `tone="accent"`, using the host's `--fact-accent`: 1px border at 35%, 8% fill, 12px padding, 8px radius.
- Container queries provide four shared subgrid columns at 720px or wider, two at 440–719px, and label-left/value-right rows below 440px. Titles span the columns. Coarse-pointer actions have 44px targets.
- The accent section spans two of the four columns at a constant width. If measured nesting exceeds three, replace its border and fill with a 3px accent left rule.
- Use sentence case, without colons after labels.

## Settled design choices

The user requested resets “in it's own little bubble as well so it's clear and draws the eye”. Manual resets therefore always gets the one accent section, including when the value is “None”.

Titles go above the facts rather than consuming a title column. The accent is two columns wide so it stays small and consistent across reset states. “Burn rate (3h)” ships in PR 1, including the card summary. Do not add a “Last checked” note.

## PR 1: Quota Management

Add a shared `src/domain/accountBilling` module for parsers, billing types and the pure billing copy model. Add `PoolAccount.billing` through collector, application and dashboard domain boundaries. Billing remains in memory.

Codex:

- Read `id_token.chatgpt_account_id` leniently from each credentials inventory entry. Missing, malformed or overlong values become null and never invalidate inventory.
- Keep this identifier out of SQLite, logs, dashboard responses and browser state.
- Read subscriptions through the existing management `requests/api-call` transport, with encoded `account_id` and the `Chatgpt-Account-Id` header.
- Gate attempts per account for six hours, including failures, scheduled polls and targeted refreshes. Record the attempt before requesting. Preserve the previous billing reading on failure.
- Determine renewal versus ending from `last_active_subscription.will_renew`, cancellation outcome and the entitlement's renewal/cancellation/expiry dates. Include scheduled plan changes and delinquency with any reported grace end.

Claude:

- Reuse the plan profile request for billing. The gate is `!profileAttempts.has(id) || now - max(planObservedAt, profileAttempts.get(id)) >= 6h`.
- Read once after restart even when the stored plan is fresh. Record billing before returning for an unknown plan.
- Estimate renewal only for an active subscription, using the next monthly anniversary of its creation date, clamped to the month's length. Label it Estimated and explain the basis; annual plans can differ. On the Quota Management page the basis is the short “from start date” and the annual-plan caveat is shown once per Accounts section (S7).

Render three drawer sections: Usage, Billing and Manual resets. At ≤ 900px an opened row reads, from the limits down: Manual resets (spanning the full row), Usage, Billing, in the visual and the DOM order, with one reset section mounted per open account; this applies on the Quota Management page only, so the shared panel keeps its own order elsewhere. From 1100px wide screens whose drawer is narrower than the panel's own 1100px threshold show Usage, Billing and Manual resets side by side, in that order; a drawer of 1100px or more keeps the three-column facts with the accent column on the right (S3). Usage contains Last reading, the window reset when not already shown, Predicted empty and Burn rate (3h). Billing uses Renews, Ends, Next plan, Payment overdue and Active since as applicable. Missing billing says Not reported with its reason; no subscription says No paid plan.

Move Use reset to the Manual resets header while preserving lazy credential loading on disclosure, spent markers, disabled reasons, provider spend paths and confirmations. Keep the closed-row “Manual resets (N)” marker and existing `<details>` / `<summary>` elements; add no nested disclosures. Keep existing `reset_*` translation keys and update all six locales with identical interpolation contracts.

## PR 2: Other account facts

Add `factsInPanel` to `QuotaBodyProps`, default off, preserving the frozen chip classes. Adopt the same panel in Codex and Claude Accounts cards, compact read-only auth-file quota sections, and provider resource sheets. Keep Refresh in the card footer; move Use reset into its panel. Use `Fact` with `variant="code"` for resource details.

The existing id-token subscription-active-until field becomes an Estimated fallback with its source visible, rather than an asserted renewal date. Do not remove the frozen `codexResetCredit*` classes.

## Evidence and accepted limits

Live read-only evidence established that the credentials endpoint exposes the ChatGPT account claim and that subscriptions accepts it. One Codex account renewed November 13, 2026 with a scheduled change to `prolite`; another ended November 4 with `will_renew:false` and `cancellation_outcome:"deactivate"`.

The subscriptions endpoint is undocumented; parsers must fail soft. Codex adds at most one request per account per six hours. Each restart adds one Claude profile request per account; in-memory billing refills on collection. Claude's monthly estimate can be wrong for annual plans. `prolite` plan weighting remains outside this change.

Regression proof must cover credential claim parsing and privacy, both six-hour gates, retained readings after failures, Claude restart and unknown-plan behavior, all fact states, action/note wiring, locale parity, reset spending/cancellation, nesting and visible reasons. Preserve the existing 25-account-disclosure test and pool-stat fact markup.
