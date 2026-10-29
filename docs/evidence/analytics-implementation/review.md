# Integrated Analytics review

Reviewer: GPT-6.1 Sol, high reasoning effort, through the configured GPT proxy.
Review scope: Prox since 07799c0, CPA Manager since c60aea1d, and the deployed
CLIProxyAPI v8.0.44 checkout since 5110699f. Original v8.0.43 work is not deployed.

Round 1: CHANGES. All five findings accepted and fixed:

| ID | Severity | Correction |
| --- | --- | --- |
| S1 | blocker | Outbound-tier ingestion calls EffectiveServiceTier, retaining non-Codex response precedence and Codex request precedence. |
| S2 | should | Request cost uses resolved billing model, then canonical analytics model, matching aggregate candidates. |
| S3 | should | Requested-tier metadata accepts the current producer's service_tier field while preferring explicit request_service_tier. |
| S4 | should | Unavailable TTFT and ambiguous legacy zero become null; explicit measured zero remains zero. |
| S5 | should | Context and service schedules use existing effective-rate helpers, inheriting omitted rates and preserving explicit zero overrides. |

Regression coverage: provider-specific tier precedence, current producer metadata,
missing/zero timing, alias detail versus aggregate cost, inherited rates and zero
overrides. Usage, monitoring, pricing and HTTP integration suites plus the Go
server build passed after corrections. Diff checks passed.

Round 2: S1, S3, S4 and S5 resolved. S2 remained open for a rate configured only
under the full requested alias, such as alias(high), when the resolved model is
unpriced. The candidate order now includes that full requested-name fallback.
The detail-versus-summary regression covers rates under both alias and alias(high)
with an unpriced resolved model. Monitoring and pricing suites and the Go build
passed after this correction.

Round 3: APPROVE. S2 resolved; Sol independently reran both alias-price regression cases. No new findings. All five findings are resolved. No findings declined. Review usage was not returned.

Deployment follow-up: the final live visual check exposed wrapped large totals.
Commit `0cc4015` only increases Analytics summary-card minimum width. Full Prox
verification and live/synthetic browser checks passed; no pricing or data logic
changed after Sol's approval. Deployment evidence is in verification.md.
