# Prox analytics research brief

Date: 2026-10-28. This research runs alongside the final compact-dashboard release.

## Requested outcome

An Analytics tab in Prox that explains the traffic passing through all configured proxy instances. The user requested input/output tokens, caching, equivalent API cost, a table of registered models and provider rates, clean chart breakdowns, and per-request metadata and performance: speed, time to first token, and response time.

This council run researches the design and implementation path. It does not deploy an analytics feature, migrate request storage, change provider authentication, or take over usage collection. The preceding UI release is separate and completed at code commit `7dd48fc`.

## Known boundaries

- GPT/Codex and Claude have separate proxy instances; provider kind is not instance identity.
- CPA Manager is the existing usage-queue consumer. Prox must not compete for destructive queue reads.
- Existing quota snapshots are not request telemetry and must not be converted into invented request history or token totals.
- Equivalent API cost is an estimate for subscription-authenticated traffic, not an invoice or subscription savings claim.
- Unknown prices, unsupported measurements, dropped telemetry and unresolved source attribution must remain explicit.
- Credential values, authorization headers and prompt/response bodies are not requested dashboard fields.
- Preserve existing source/session isolation, LAN access, model catalogs and inference behavior.

## Questions assigned to the council

1. What can be measured truthfully today, and which fields are lost before persistence?
2. How should the request ledger distinguish an incoming request from its provider attempts and retries?
3. Which existing owner should supply querying, pricing, normalization and storage?
4. How should provider/model aliases, pricing revisions, tiers, token categories and unknown rates work?
5. Which chart and table views answer useful questions, with filters that reconcile to request details?
6. What staged rollout and tests establish completeness, isolation, accuracy and operability?

## Option space

1. Prox reads CPA Manager's existing analytics API directly.
2. A narrow authenticated Prox adapter reads an explicit CPA Manager analytics contract.
3. A dedicated analytics service receives data from the existing collection pipeline.
4. Adopt an external observability platform, with a link or integration from Prox.

Useful hybrids remain in scope. No option is approved by this brief.

## Review structure

Phase 0: independent assumption and existing-owner review. Phase 2: five parallel seats—implementation sequence, architecture/product design, external evidence, internal data audit, and adversarial execution review. Phase 3: cross-examination if positions disagree or a live objection remains. Parent synthesis follows, then independent verification of its grounding and coverage.

All research uses repository source, synthetic checks where useful, and public primary references. Runtime facts must be labelled separately; source defaults do not establish deployed settings or historical coverage.
