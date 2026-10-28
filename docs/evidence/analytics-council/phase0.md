# Phase 0 — assumptions and existing owners

Parent archived the read-only reviewer's returned report below. Its original statement that no report was written describes the reviewer action; this file was created afterward by the parent.

**The brief does not collapse to a UI-only question.** Existing infrastructure covers much of the data pipeline, but provider pricing, measurement semantics, and source attribution remain essential research.

**Reframed brief:** Determine how Prox can expose CPA Manager’s retained request data and pricing rules across configured proxy instances, with explicit coverage and measurement limits, while preserving CPA Manager as the sole usage consumer.

Read-only review completed using the [council phase-0 guidance](/home/swerve/.agents/skills/council/SKILL.md). No files, credentials, queues, or production services were accessed or changed beyond reading repository source. **`phase0.md` was not written:** the governing reviewer instruction prohibits all file writes. The requested directory was absent when checked.

Evidence snapshot: Prox `0afa198`, core `5999980c`, CPA Manager `c60aea1d`; these identify local checkouts, not deployed versions. Prox’s existing stylesheet edit and untracked UI evidence were preserved.

## Contradictions

- None found in the product requirements. “Every request” is an unresolved coverage promise, not something the existing pipeline establishes.

## Ambiguity

- **1. “Every request”: inbound request or provider execution?** Core records distinguish parent requests from execution IDs ([queue payload](/home/swerve/src/CLIProxyAPI/internal/redisqueue/plugin.go:181)). CPA Manager’s normalized event exposes `RequestID`, but no corresponding execution-ID field ([event schema](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event.go:17)). Retries, failures, cancellations, and internal executions therefore need explicit counting rules.
  **Suggested question:** Should rows represent client requests, individual provider attempts, or both?
  **Cheapest probe:** Trace existing retry/accounting fixtures through normalization and event hashing; document which identifiers survive. Do not promise complete historical coverage.

- **2. “Speed,” “TTFT,” and “total response time”: measurement boundaries differ.** Core latency starts at reporter creation. TTFT can measure a substantive token event, first response byte, or first-packet fallback ([timing implementation](/home/swerve/src/CLIProxyAPI/internal/runtime/executor/helps/usage_helpers.go:381)). CPA Manager currently calculates speed as output tokens divided by full latency ([existing formula](/home/swerve/src/CPA-Manager-Plus/apps/web/src/features/monitoring/model/eventRows.ts:21)). That is not necessarily generation throughput or client-observed completion time.
  **Suggested question:** Is the requested comparison proxy-observed response speed, generation throughput after TTFT, or end-to-end client experience?
  **Cheapest probe:** Trace timing call sites and existing synthetic tests for each provider and transport; identify unsupported and fallback measurements separately.

- **3. “Equivalent API cost” and “registered models per provider”: the billing identity is unspecified.** The runtime registry describes models and capabilities, without price fields ([registry](/home/swerve/src/CLIProxyAPI/internal/registry/model_registry.go:40)). CPA Manager’s price repository keys entries by model ID, rather than an explicit provider/model tuple ([price repository](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/repository/modelprice/repository.go:77)). Its documentation also states that historical costs may use current prices.
  **Suggested question:** Does equivalence mean current first-party public API rates, actual routed-provider rates, or rates effective when each request occurred—and in which currency? Must the table include registered models with no usage?
  **Cheapest probe:** Compare registry, alias, response-model, and price lookup contracts; then check official provider pricing and cache/service-tier definitions. Preserve unknown prices as unknown, rather than interpreting a zero estimate as free usage.

- **4. “Clean breakdown charts”: the required comparisons are unspecified.** CPA Manager already offers overview, trends, model/API-key/credential rankings, heatmaps, and request previews ([analytics manual](/home/swerve/src/CPA-Manager-Plus/apps/docs/en/manual/usage-analytics.md)).
  **Suggested question:** Which comparisons must the first Analytics tab answer, over which time ranges and timezone, and must chart filters reconcile exactly with request rows?
  **Cheapest probe:** Inspect the existing analytics request/response and UI fixtures, then identify the smallest required set of views. Acceptance should name fixture inputs and expected totals, missing-data states, and filter behavior.

## Missing Constraints

- **5. History and completeness contract.** Three different retention systems exist:
  - **Core:** an in-memory queue with a default 60-second retention and maximum 3,600 seconds; usage emission is gated. Subscribers alter delivery behavior, and queue reads remove records ([queue](/home/swerve/src/CLIProxyAPI/internal/redisqueue/queue.go:9), [destructive handler](/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/usage.go:23)).
  - **CPA Manager:** SQLite request storage, hourly/pricing rollups, and archive retention. Automatic retention defaults to disabled, with a 30-day setting when enabled ([configuration](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/config/config.go:27)). Archived/deleted raw history is not automatically available to ordinary exports; aggregate availability does not imply request-detail availability.
  - **Prox:** quota observations, collected every five minutes and retained for 30 days—not request records ([quota ownership](/home/swerve/src/prox/server/quota/RULES.md), [pruning](/home/swerve/src/prox/server/quota/store.ts:328)).

  **Resolution needed:** Define request-detail versus aggregate horizons, freshness expectations, and how collection gaps appear.
  **Cheapest probe:** Inspect archive/query coverage tests and sanitized deployment evidence already available. Effective production settings and historical loss remain unknown; source defaults cannot establish them.

- **6. Metadata disclosure contract.** Core emits client IPs, user agents, response headers, credential-related identifiers, and failure details. CPA Manager deliberately restricts several fields to authenticated monitoring or internal storage ([event restrictions](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event.go:36)).
  **Resolution needed:** Name the metadata fields Analytics may expose, their masking rules, and the authorized audience.
  **Cheapest probe:** Compare existing monitoring DTOs and persistence-security fixtures. Reuse the owning boundary’s disclosure rules; do not treat raw events as browser-safe payloads.

## Execution Risks

- **7. Existing analytics is not a drop-in Prox endpoint.** Prox requires v8 management contracts ([repository guidance](/home/swerve/src/prox/AGENTS.md)); CPA Manager exposes analytics through authenticated `POST /v0/management/monitoring/analytics` using its panel authorization ([handler](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/http/controller/monitoring/handler.go:20)). Checked-in Prox routing connects the core instances and quota-history service, with no CPA Manager analytics route ([routing](/home/swerve/src/prox/deploy/provider-routes.conf:5)).

  **Suggested fix:** Before implementation planning, identify the supported service contract, authentication boundary, and permitted ownership changes. Preserve CPA Manager’s collection, normalization, persistence, and pricing ownership; do not duplicate its calculations in React or access its private database directly.

  **Cheapest probe:** Trace routing, API clients, authorization, and existing handler fixtures entirely in source. Runtime compatibility remains unverified. Future acceptance must exercise an offline fixture through the chosen boundary and verify authorization, normalized totals, missing-price coverage, and error behavior.

## Topology Gaps

- **8. Proxy-instance attribution is not established end to end.** Checked-in deployment files corroborate GPT/Codex `8317`, Claude `8319`, Prox `18318`, and history `18319`; they do not prove current runtime state. Prox explicitly distinguishes instance identity from provider kind ([source rules](/home/swerve/src/prox/src/domain/providerSources/RULES.md)). CPA Manager supports multiple upstream collectors writing to one store ([extra collectors](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/worker/extra_collectors.go:14)), but the normalized event schema has no explicit Prox instance ID. Its `Source` field concerns credential/source identity and must not be assumed to identify a proxy instance.

  **Resolution needed:** Establish how every retained event maps to a configured instance, including duplicate provider kinds, aliases, retired instances, and unresolved history. Define whether an unavailable source produces partial results or an error.
  **Cheapest probe:** Trace collector enrichment, normalized events, persisted schema, and source-isolation fixtures. Use sanitized existing deployment evidence to compare revisions; leave deployment coverage unknown where evidence is absent.

## Verdict

`service_tier = "default"`

**GAPS FOUND — 8 issues above must be resolved before plan generation.**

**Keep external research in scope.** Internal evidence establishes substantial reusable infrastructure. Official pricing evidence is still needed to define API equivalence, and observability evidence is needed before claiming comparable TTFT, complete request capture, or client-observed response time. No implementation, delegation, tests, or production probes were performed.
