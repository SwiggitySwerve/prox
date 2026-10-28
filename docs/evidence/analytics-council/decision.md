# Council — Prox request analytics

Council synthesis, 2026-10-28. Cross-examination and one independent verification pass are complete. The parent applied the verifier's single acceptance-criterion correction; no second verification pass is claimed.

**Decision:** build the Analytics tab on CPA Manager's retained request data, through a small authenticated adapter in Prox's existing server. Keep collection, accounting, pricing, retention and analytical queries in their existing CPA owners. Improve those contracts before presenting precise per-instance counts, complete costs or comparable TTFT.

The UI release is already complete: code commit `7dd48fc` is deployed at Prox, all 56 visual-review cells have medians of at least 9.0, and the long-name mobile row retains its full names and height. This document concerns the next feature. No analytics implementation or deployment has occurred.

## What the research establishes

| Requested capability | Existing evidence | Required improvement |
|---|---|---|
| Input, output and caching | Core has canonical token accounting; CPA retains input/cache fields and raw output/reasoning | Preserve canonical output, accounting quality, measurement presence and cache-write lifetime through storage and the read API. Provider semantics differ. |
| Equivalent API cost | CPA owns pricing rules, context/tier handling and aggregate calculations | Return owner-calculated per-row cost, price status, measured-component coverage and rate revision. Unknown price must remain distinct from explicit free pricing. |
| Registered models by provider | Prox enumerates configured sources and source-owned catalogs | Join current registration to the CPA rate resolver; include unused/unpriced models and show alias, upstream/billing identity, tier, context and rate provenance. |
| Request and retry details | Core emits parent request and execution identifiers | CPA must preserve instance/execution identity; distinguish executions from supplementary model usage and inbound requests. Add terminal parent outcome before claiming client success or exact retries. |
| Speed and response time | CPA has reported execution latency and output/full-latency speed | Name the existing measurement correctly. Add common-origin timing and presence for stronger measurements; do not subtract today's differently based TTFT and latency. |
| TTFT | Core paths report content, first byte or fallback packet timing | Preserve method. Claude's built-in streaming currently measures first byte; some Codex paths observe substantive output. Compare like measurements. |
| Every request | CPA has a retained usage ledger, not a complete inbound access ledger | Future ingress/lifecycle records plus durable delivery are needed for stronger coverage. Admission failures, no-usage streams and lost queue records can be absent. Missing historical records cannot be reconstructed from quota snapshots. |

Sources: the [field-by-field and transport audit](phase2-internal.md), [adversarial probes](phase2-adversary.md), and [official provider and observability references](phase2-external.md). Findings describe checked-out source, not a private production-history audit. [Checkout revisions](checkout-revisions.json) record the source baseline.

## Architecture and alternatives

The proposed path is:

```text
Claude / GPT / other configured proxy instances
  → existing CPA collector (one consumption path per logical queue)
  → CPA canonical usage, storage, pricing and analytics queries
  → narrow authenticated Prox adapter (fixed read operations)
  → Analytics views, charts and request details
```

The adapter adds no request store, pricing calculator or queue subscriber. It calls public CPA service contracts. Prox's provider-source manifest remains the configuration owner; explicit private configuration binds the analytics dataset and credentials. The browser receives capabilities and safe results, never the CPA credential. Prox's core management traffic remains v8. CPA's separately named v0 panel API is a different application contract, not a legacy core fallback.

| Option | Decision rationale |
|---|---|
| Direct CPA browser API | Credible simpler alternative for an explicitly whole-dataset CPA administrator session. Requires separate supported CPA authentication and origin/session handling. It does not repair identity or accounting gaps. |
| Small Prox adapter over CPA | Preferred for integrated navigation, server-held CPA credentials, fixed read operations and existing source/session lifetimes. Must enforce the declared dataset scope; source selection alone grants no authority. |
| Separate analytics service/store | Defer unless measured load or retention needs justify it. Existing callback fanout is not a durable outbox; a new store needs replay, checkpoints and reconciliation. |
| External observability product | Optional later supplement for operations. Langfuse/Helicone offer useful patterns, but inherit missing data and need a safe export. They do not justify another core consumer. |

The authenticated adapter should be small. For this homelab, an explicitly declared shared analytics scope can cover the managed dataset. Do not build a speculative roles framework. A portable/external source without a configured analytics capability remains unsupported, rather than silently receiving the homelab dataset. Historical rows without proven instance identity remain unattributed; narrow source views must not assign them by model, account name or selected tab.

## Dashboard design

One primary **Analytics** tab under Observe, beside Quota Management and Logs, with a shared date range, timezone, instance/provider/model filters and outcome filters. Request details retain the same query scope. Capability-dependent filters appear only when the server can enforce them. “Unknown” remains a real category. Each chart has an accessible table or text equivalent. Reuse Prox's compact layout and theme; enumerate the same source/query results into every view rather than introducing per-provider page wiring.

| View | Charts and numbers | Drilldown |
|---|---|---|
| Overview | Retained events or verified requests, errors, input/output, priced cost subtotal, p50/p95 duration; aligned volume/cost/latency trends and provider/model bars | Click a bucket or category to open matching request rows. Show freshness, coverage and exclusions near the affected totals. |
| Tokens & Cache | Disjoint input/read/write trends; canonical output and reasoning breakdown; cache-read token share and events with reads | Show reported and normalized values, accounting version and missing categories. Prompt caching and application response caching remain distinct. |
| Cost | Estimated API-equivalent cost over time, provider/model components, priced-event coverage and unresolved prices | Request cost components, selected billing model/rate revision, tier/context, exclusions. Include billable failed and retried work. |
| Performance | Separate execution-duration and first-response distributions; p50/p95 with sample counts; output/full-duration rate; output-size versus duration | Compare consistent streaming/outcome/timing-method cohorts. True generation timing appears only when instrumented and supported. |
| Requests | Server-paginated rows with time, source, provider, requested/resolved model, recorded outcome, tokens/cache, cost and timing | Detail drawer for safe operational metadata and known parent/execution relationships. Distinguish redacted, unreported, expired and unsupported fields. |
| Model Rates | Provider/source grouped registration inventory including unused and unpriced entries | Alias/upstream/billing mapping, currency/unit, input/output/read/write rates, write lifetime, tier/context schedules, source URL, observed/effective dates and rate status. |

Request detail should preserve useful authorized diagnostics: endpoint/method, requested/effective/response tier, reasoning setting, streaming mode, safe error summary, session/trace references and supported client metadata. CPA's owner decides the projection before serialization. Credentials, arbitrary raw headers, raw JSON, prompt/response bodies and internal failure bodies are excluded. This is metadata analytics, not transcript capture.

Charts must preserve gaps. No dual axes mixing unrelated units, no percentage stacked bars over unknown totals, no averaged p95s, and no global total calculated from the visible request page. A chart click must reproduce the same filters, denominator and dataset/rate revision. Where rollup or retention limits prevent exact detail reconciliation, the API must say so rather than fabricate rows.

## Accounting and price policy

CPA owns the arithmetic. Preserve existing behavior in a separately verified refactor before changing incorrect or incomplete rules. Core's canonical accounting is the starting contract: OpenAI and Claude reasoning is included in output; Gemini's candidate output and thoughts are separate in the audited parser. Adding reasoning universally double-counts some providers and omitting it universally undercounts others.

For the first useful release, label amounts **Estimated API-equivalent cost at current configured rates**. Return the rate-book revision and valuation time. This is neither subscription spend nor an invoice. Registered aliases such as Astra or Terra receive a price only after an authoritative billing-model mapping; never infer it from a display name.

Pricing availability considers measured usage as well as rate lookup. Required distinctions include priced, explicit zero, partial and unpriced, with reasons. A known token subtotal is not a complete request price if cache-write lifetime, effective tier, modality or tool units are missing. Show priced-event coverage and omitted components. The current pricing structure revision is not a monetary rate-book revision: rate-only edits need their own identifier for reproducible results.

Current official references describe model-specific cache-write lifetimes, context thresholds and tier rules. The external report includes observed examples, primary URLs and access failures. Those observations are not evidence that every local producer emits the fields or that today's rate applied historically. Immutable rate snapshots and verified effective intervals can support a later historical valuation mode; a snapshot alone does not prove historical applicability.

## Delivery sequence and acceptance

This research selects the direction and acceptance criteria; the following changes are proposed, not implemented gates.

1. **Deliver a retained-data preview.** Configure the explicit shared dataset binding, fixed read adapter and CPA-owned operational-detail projection. Show retained-event overview, existing provider/model trends, paged details and honestly labelled timing. Suppress known-wrong cost components and unsupported instance controls. This useful first slice needs no new collector or durable queue, and is not completion of the full brief.
2. **Correct and complete retained analytics.** Preserve stable collector-bound instance identity, usage-record identity and execution relationships in CPA. Preserve canonical token/output/presence fields, effective tiers and pricing availability through raw storage, projections and archives. Refactor with unchanged numerical baselines first, then make separately verifiable correctness fixes. Add owner-calculated per-row costs, TTL/unit-aware partial pricing, model-rate inventory, source filters and snapshot-aware queries. Finish Tokens & Cache, Cost and Performance views over supported retained evidence.
3. **Meet the forward every-request requirement.** Instrument inbound lifecycle before admission, coherent first-byte/content/terminal timing, explicit attempts and supplementary-record relationships, cancellation and no-usage outcomes. Add durable producer-side capture with acknowledgement/replay into the existing CPA collection chain and reconciliation from a declared cutoff. From the declared cutoff, every inbound inference operation reaching the declared proxy ingress across all configured in-scope instances, routes and transports must have a stable lifecycle/detail entry, including admission rejection, no-usage completion, cancellation and incomplete termination. WebSocket operations count separately from socket sessions. Reconcile against independently enumerated ingress fixtures, including failures before and during the durable write, producer/consumer crashes and replay. Capture failures or unaccounted operations make the affected interval partial/unknown and prevent an every-request completion claim for that interval. Missing provider usage and unresolved prices remain unknown within an existing request entry. This stage is required to fulfil the original every-request brief prospectively. A CPA post-persistence outbox alone cannot repair earlier loss, and past missing records remain missing.
4. **Verify and release analytics.** Exercise the data/migration oracles, source/session isolation, bounded query performance on disposable data, real binding compatibility, and browser flows for filters, details, charts, paging and failure states. Keep capture-scope and measurement limits explicit. Enable the analytics capability only after its own checks; rollback disables readers/UI while compatible collection continues. Historical rate books and a separate observability platform remain optional.

Acceptance fixtures include identical IDs across sources; alias routes enumerated once; failed retry plus successful execution plus supplementary model usage; exact replay and archive restore; cache-inclusive/separate input, reasoning and missing-vs-zero usage; missing-vs-free prices, write lifetimes and effective tiers; source outage and raw/rollup-only history; timing methods and invalid denominators; same-timestamp pagination and late ingestion; logout/reconfiguration during requests; and secret sentinels excluded from every response/export. Detailed owner boundaries and probes are in the [implementation report](phase2-implementer.md) and [adversarial report](phase2-adversary.md).

No new collector, automatic archive restore, retention purge, inference-routing change, new database or chart-library replacement is justified by this research. Query limits and any extra indices follow measured disposable-data benchmarks. Reuse existing components and theme tokens; new chart primitives must preserve missing intervals rather than reusing the current gap-collapsing sparkline unchanged.

## Evidence, disagreement and remaining facts

The five independent positions are [implementation](phase2-implementer.md), [architecture/product](phase2-strategist.md), [external primary evidence](phase2-external.md), [internal audit](phase2-internal.md), and [adversary](phase2-adversary.md). [Phase 0](phase0.md) established the ownership and coverage questions. [The brief](brief.md) records scope and options.

The adversary ran 17 mocked Prox tests with Bun 1.4.2 rather than the repo-pinned 1.4.3; this is a bounded source/session check, not release certification. The internal audit ran 13 source/in-memory checks, not the Go implementation. External cost examples were recalculated. No analytics runtime, private database, credential, queue, migration or production completeness check was performed.

One factual conflict is resolved: the audited CPA `VerifyPanelHeader` delegates to admin verification and `PanelUsesExternalManagementKey` returns false. The internal report's broader suggestion that external-management-key mode may apply is not supported by this checkout. Deployed equivalence still needs a later check; never assume a core key authenticates CPA.

Preserved dissent: direct CPA API access may be the least-maintenance solution for an explicit whole-system admin view. The adapter is chosen for integrated credential placement and bounded transport, not because the CPA path contains v0. A separate service/platform remains viable if future measurements justify it.

Remaining runtime facts: actual collector source mapping and modes, deployed schema versions, retention/archive bounds, historical attribution evidence, rate-book freshness, authorized analytics scope and query performance. These are implementation probes, not reasons to guess values or ask the user to provide credentials in chat.

## Cross-examination and final decision

Both proposers retained the adapter and existing owners, then changed their proposals in response to the evidence. [Implementation response](phase3-implementer.md); [strategy response](phase3-strategist.md).

- Reduce access design to one explicit shared homelab dataset binding. No general roles system or assumed core-to-CPA authentication.
- Preserve useful authorized IP/UA/session/trace diagnostics in details instead of blanket stripping metadata.
- Treat usage records, actual upstream attempts and inbound requests as different units. Supplementary records need an explicit relationship and additive-versus-overlapping usage semantics before parent costs can be summed.
- Preserve arithmetic only during the refactor; subsequently fix known output/tier defects. A matching model price does not establish complete cost when measurements or tariff dimensions are missing.
- Promise exact chart/detail equality only for compatible scope, ingestion/rollup cutoff, accounting and rate revision with retained details. Otherwise show the limitation.
- Bring forward the useful retained-data preview, while making prospective lifecycle capture and durable delivery an explicit completion gate for every-request coverage. Withdraw unmeasured engineering-day totals as a decision basis.

**Survival score: Modified.** The integration direction survived, but its scope, data semantics, metadata policy and completion criteria changed materially under challenge. The direct-admin alternative remains viable; it is not rejected by endpoint version spelling.

**Tradeoff accepted:** a small adapter adds transport maintenance to keep CPA authority server-side and integrate Prox sessions. It avoids a second ledger or accounting engine. Initial retained history has explicit gaps; only measured future capture can establish stronger coverage. Revisit the service boundary only if query measurements, retention requirements or independent operational needs justify it.

**Research status:** implementation-ready recommendation; no analytics code, migration or deployment performed. This completes the research deliverable, not the dashboard feature. Phase 5 spec verification does not apply because no OpenSpec change was authored. Phase 6 implementation does not run because the active request is a research run. The earlier compact UI deployment remains complete.

**Review accounting:** one assumption reviewer, five independent Phase 2 seats, two fresh cross-examination reviewers, and one synthesis verifier: nine native subagent invocations. No role was simulated. The [independent verdict](verification.md) was REVISE for one material denominator issue: counting only durably observed operations could hide loss before capture. The parent applied the requested ingress-based criterion in stage 3 verbatim. The other three checks passed. No second-pass VERIFIED verdict is claimed.
