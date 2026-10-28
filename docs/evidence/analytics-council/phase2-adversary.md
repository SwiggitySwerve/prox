# Phase 2 adversary — Prox request analytics

**Verdict: a narrow authenticated Prox adapter over CPA Manager survives, with changes required in CPA's owning domains. An unchanged API bridge cannot satisfy instance-specific history, reliable execution identity, or trustworthy cost availability.** Direct CPA API reuse remains a credible simpler alternative for an explicitly CPA-wide administrative view. A separate store or external platform does not repair information already lost before or during ingestion.

Research date: 2026-10-28. This is one assigned adversary's independent source review, not the Captain's synthesis or a review of other seats' proposals. No other roles' reports were read. No implementation, deployment, commits, production calls, credential access, or queue reads were performed. The only authored file is this report. Existing source and tests were inspected; local mocked tests and memory-only numerical counterexamples are reported below. No UI scores were assigned.

## What survived and what failed

| Approach | Verdict | Conditions and actual failure modes |
| --- | --- | --- |
| Reuse CPA API directly from Prox | Survives for a CPA-wide admin view; incomplete for the full brief | Use a distinct CPA endpoint/authentication contract and preserve its coverage response. Existing analytics already provides summaries, timelines, breakdowns and paginated events. However, its typed contract cannot filter proxy instances, event rows lack execution identity, row cost currently needs client calculation, and access uses the CPA admin credential. Giving an ordinary source session access to the whole CPA dataset would widen authority. |
| Narrow authenticated Prox adapter over CPA | Preferred conditional survivor | Authenticate the browser separately from CPA; map allowed logical instances to CPA data on the server; expose bounded, read-only operations and an allowlisted metadata projection. Reuse CPA accounting/pricing owners. This requires CPA to expose missing identity, availability and measurement semantics. A transport-only adapter cannot manufacture them. |
| Dedicated service fed by CPA's existing collector | Possible, presently unjustified | Preserve CPA as the sole core consumer. CPA has a post-insert handler fanout, but it is not a durable outbox: a crash after insertion and before delivery leaves a downstream service behind. A new durable export/checkpoint/replay contract and derived-store ownership are prerequisites. Copying SQLite tables or adding another pricing engine violates the owner boundary and duplicates maintenance. |
| External observability platform | Possible complement; not an evidenced replacement | Feed only a safe CPA-owned export, never another core queue reader/subscriber. It could add exploration, alerts and retention. Nothing inspected establishes an exporter, delivery guarantees, provider pricing parity or historical completeness. Every identity and measurement defect follows the data into the platform. No particular product is rejected on untested performance or cost claims. |

The preferred design has two distinct responsibilities: CPA owns retained usage, accounting, pricing and safe projections; the Prox adapter owns authentication, source authorization and transport. Business arithmetic must not migrate to Prox rendering or become a second independent adapter implementation. Reuse the existing CPA owners, extending their public contracts and rules where necessary.

## Evidence and attacks

All linked source paths below were verified with `rg --files` during this research turn. Line anchors describe the inspected working tree; the Captain's concurrent work can move them. “Missing” means absent from the inspected contracts, not a claim about undisclosed deployment components.

### 1. Queue exclusivity and ingestion completeness are hard limits

Core [queue.go](/home/swerve/src/CLIProxyAPI/internal/redisqueue/queue.go:9) sets retention to 60 seconds by default, capped at 3,600 seconds. It holds data in memory. [GetUsageQueue](/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/usage.go:23) destructively calls `PopOldest`; this is not a historical query. Disabling the queue clears its contents and subscribers.

There is an additional trap beyond competing HTTP pollers: `Enqueue` sends to subscribers **instead of** retaining a queue copy. `publishToSubscribers` removes/closes a subscriber when its buffer is full and still returns true for that publication. Thus a new subscriber can divert traffic away from an HTTP collector, and an overflowing subscriber has no durable replay guarantee. The existing [queue test](/home/swerve/src/CLIProxyAPI/internal/redisqueue/queue_test.go:8) explicitly expects the queue to be empty after subscriber broadcast. No queue function or queue endpoint was executed in this review.

CPA [consumeHTTP/processItems](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/collector/collector.go:348) pops before normalization and insertion. A database insertion error returns after the pop; the inspected path has no acknowledgement/requeue step. Malformed records go to dead letters, but the dead-letter write error is ignored. Collector status has inserted/skipped/dead-letter counts and recent timestamps; these are operational observations, not a numerator and denominator proving all upstream requests arrived.

**Consequence:** kill any proposal to collect again from Prox, subscribe “just for charts,” recover missing historical traffic from the queue, or call an empty interval proven zero traffic. Show retained observations, collector freshness and known gaps. Separate ingestion uncertainty from raw-retention coverage. No approach can recover events that were never durably retained without another independent historical source.

The CPA HTTP collector currently constructs `/v0/management/usage-queue` in [httpqueue/client.go](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/httpqueue/client.go:118). Core still registers that route in [server_management.go](/home/swerve/src/CLIProxyAPI/internal/api/server_management.go:93), as well as `/v8/management/observability/usage/queue` in [server_management_v8.go](/home/swerve/src/CLIProxyAPI/internal/api/server_management_v8.go:41). Therefore the spelling alone is **not** evidence the existing collector is broken. Actual deployed mode/version/coverage remains unverified; Prox must not introduce a legacy core data fallback.

### 2. Credential identity is not proxy-instance identity

CPA [Event and NormalizeRaw](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event.go:18) retain provider, credential source/hash, auth index and several snapshots. Neither `Event` nor analytics `Filters`/`EventRow` has a proxy-instance field. `SourceHash` hashes the original credential source; the [usage identity rules](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/RULES.md) explicitly describe its credential/account purpose. Relabeling that field “instance” is incorrect.

The analytics handler uses ordinary JSON decoding without rejecting unknown fields. Sending a speculative `filters.instance_ids` field to this API therefore does not establish a source restriction: that field is ignored. A bridge must validate capabilities and enforce scope before returning data; filtering an already returned CPA-wide dataset in the browser is not authorization.

[StartExtraCollectors](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/worker/extra_collectors.go:14) creates collectors for extra upstream URLs, reuses the primary management key and settings, and writes all events into the same store. Runtime configuration knows the upstream, but `processItems` does not attach it as persistent event identity. The worker only skips an upstream string equal to the primary after trimming trailing slashes. [splitCSV](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/config/config.go:403) trims entries without deduplicating extras. Equivalent routes or repeated extras can therefore create multiple consumer paths for one logical instance. This is a configuration risk demonstrated by code, not a claim that the current deployment contains duplicates.

The [extra-collector test](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/worker/extra_collectors_test.go:14) verifies use of the primary key, not isolation between independent auth scopes. That behavior is compatible with an intentionally shared key, but cannot simply extend to every instance in Prox.

Prox's [source rules](/home/swerve/src/prox/src/domain/providerSources/RULES.md) already require stable logical instance IDs, one inventory entry per instance despite route aliases, and explicitly declared credential-sharing scopes. [SourceRegistry](/home/swerve/src/prox/src/services/providerSources/registry.ts:60) shares a key only within the selected auth scope. [SourceSessions](/home/swerve/src/prox/src/services/api/sourceSession.ts:45) and [source leases](/home/swerve/src/prox/src/services/api/sourceLease.ts:4) invalidate stale work across replacement, logout and view disposal.

**Consequence:** source-specific analytics is blocked until the owner can persist and filter stable instance identity, or until an independently verified one-instance-per-store mapping makes attribution unambiguous. Existing mixed historical rows cannot be assigned by provider, email, auth index or selected tab. Mark them unattributed. A CPA-wide admin view can display them honestly without claiming per-instance precision. Two routes to one CPA dataset must not be summed twice.

### 3. Parent request IDs cannot replace execution IDs

Core [plugin.go](/home/swerve/src/CLIProxyAPI/internal/redisqueue/plugin.go:68) emits `request_id` from logging context, `execution_id` from the individual usage record, and a separate `trace_id`. The [Scheme B tests](/home/swerve/src/CLIProxyAPI/internal/redisqueue/plugin_test.go:719) explicitly preserve that distinction; one test uses an eight-character trace ID and a UUID execution ID. Session-parent identity is a separate hierarchy again.

CPA normalizes only `request_id` into its typed event. [buildEventHash](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event.go:1329) hashes request ID, timestamp, endpoint, model, auth index, source hash, several token fields, failure flag and optional latency. It omits execution ID and instance identity; it also omits provider, TTFT and fine-grained cache fields. [Repository insertion](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/repository/usageevent/repository.go:380) claims an identity-ledger entry by event hash and inserts events with `insert or ignore`.

A memory-only, source-checked reproduction confirmed that three otherwise equal records differing in execution or instance identity produce one current hash; a uniqueness constraint retains one. This is a deterministic possible collision, **not evidence of its frequency in production**. Conversely, retries with different timestamps or latency can remain separate rows under one request ID. A UI deduping by parent ID would incorrectly erase those attempts. The raw JSON may retain `execution_id`; the objection is the missing typed identity, dedupe and query contract, not proof every copy of the field has been erased.

**Consequence:** define rows and counts as observed executions/usage events versus parent requests. Preserve parent, execution and instance separately. Future idempotency must distinguish instances and executions while suppressing replay of the same usage event. Before selecting an exact unique key, test retries, streaming updates and any multiple-record-per-execution behavior; `(instance, execution)` alone is a candidate, not an established cardinality contract. Legacy rows need a documented fallback and uncertainty state. A new identity rule must not silently double-import old archives.

### 4. Existing accounting is reusable; adding token fields is not

Core [accounting.go](/home/swerve/src/CLIProxyAPI/sdk/cliproxy/usage/accounting.go:25) defines mutually exclusive input buckets (uncached/read/write), mutually exclusive output buckets (non-reasoning/reasoning), unclassified tokens, and accounting quality. CPA [NormalizeCacheAccounting/CompatibleCachedTokens](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event.go:281) handle separate versus included input caches and legacy mirrors. Its event-page [read projection](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/repository/usagemonitoring/event_page_read.go:177) returns normalized total input and residual compatibility cache, not an untouched copy of the core payload.

The [canonical v2 fixture](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event_test.go:447) has 233,705 input tokens, including 232,576 cache-read tokens, and 1,148 output tokens, including 458 reasoning tokens. Its correct total is 234,853. Summing input + output + reasoning + cached produces 467,887, an overcount of 233,034. This arithmetic was reproduced locally from the checked-in fixture.

The owner already has useful validation; do not rebuild token inference in Prox. However, the analytics row contract lacks an explicit canonical breakdown/quality projection. Legacy normalization also has a `totalTokens <= 0` fallback that adds reasoning to output; that cannot universally establish subset semantics for older payloads. Missing numeric usage can normalize to zero. Therefore no adapter should certify every retained zero as measured zero or apply a universal “subtract reasoning” repair.

**Consequence:** expose an owner-derived breakdown and accounting quality before promising additive stacked charts. Retain authoritative totals and an unclassified/unknown category. Label reasoning and cache as subsets wherever the owner cannot prove mutually exclusive buckets. Aggregate totals over the full query range, never just the loaded request page.

### 5. Price book reuse needs availability and valuation semantics

CPA [modelprice repository](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/repository/modelprice/repository.go:69) keys rates by model string. Its [ModelPrice](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/model/model_price.go:3) includes source/model provenance, configured flags, context tiers, service tiers and update/sync timestamps. Those are useful existing contracts. Core [ModelInfo](/home/swerve/src/CLIProxyAPI/internal/registry/model_registry.go:38) has capabilities and limits, not prices.

CPA [runtime-model discovery](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/modelprice/service.go:416) resolves a configured upstream, fetches its keys/models, and compares normalized model strings with the price book. It is not evidence of a provider-and-instance-complete inventory across extra collectors. No discovery or price sync was invoked here.

The [monitoring service](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:1009) obtains a current price snapshot and computes costs from token aggregates. A snapshot stabilizes a query; it is not a rate effective at event time. [CostForModel and candidate resolution](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/pricing/cost.go:36) return zero when no rate is found. The same owner supports explicit zero rates, cache fallback ratios, context bands, service tiers and model-specific official fallbacks. [Cost tests](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/pricing/cost_test.go:449) distinguish configured zero behavior internally. A numeric result alone does not expose those distinctions.

This is separate from pricing-rollup coverage: CPA [pricing coverage tests](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/pricing_coverage_test.go:53) fail closed when archived pricing inputs cannot be recovered. That good protection does not make an absent model rate distinguishable from a free rate in the float-only pricing function.

**Consequence:** label existing valuation “estimated API-equivalent cost at the current price book,” including currency/unit and price-book timestamp/revision. It is not an invoice, subscription spend, or historical rate guarantee. A complete estimate requires all billable dimensions; unsupported tool/image/audio/request charges need an explicit limitation. Do not silently invent their prices.

The owner should return nullable cost plus status (`priced`, `partial`, `unpriced`, `explicit-zero`), matched model/rule, pricing provenance, and priced/unpriced counts or token coverage. A known subtotal is acceptable if clearly partial. Preserve explicit free rates. Missing rates must not become `$0.00` or disappear from a share chart.

A registered-model price table should preserve source instance, provider/route and registered identifier, and show which reference price it matched. Model-only rates can legitimately serve several providers as a declared reference basis. They cannot represent two provider-specific tariffs for the same model without an owner-level schema/rule extension. Do not confuse the price source (`Source`) with the actual request provider. Price-rule matching, context thresholds and service tiers belong in CPA, including per-request cost; [EventRow](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:859) currently has tokens/timing but no calculated cost result.

### 6. Latency, TTFT and speed do not have interchangeable clocks

CPA's existing [eventRows.ts](/home/swerve/src/CPA-Manager-Plus/apps/web/src/features/monitoring/model/eventRows.ts:21) calculates `outputTokens / (latencyMs / 1000)` and returns null for nonpositive output/latency. It is full-latency output throughput, not post-first-token generation speed.

Core [UsageReporter](/home/swerve/src/CLIProxyAPI/internal/runtime/executor/helps/usage_helpers.go:433) starts TTFT at request send, can observe a substantive token or mark the first response byte, and [ttftDuration](/home/swerve/src/CLIProxyAPI/internal/runtime/executor/helps/usage_helpers.go:749) falls back to the first packet or zero. Full latency begins at `requestedAt`, so subtracting the reported TTFT is not guaranteed to subtract the same clock interval. The serialized payload supplies a number, not which measurement path produced it. Its [tests](/home/swerve/src/CLIProxyAPI/internal/runtime/executor/helps/usage_helpers_test.go:651) cover round-trip start, body-read behavior, token events and error-response packet fallback.

For 100 output tokens and 2,000 ms latency, the current formula gives 50 tokens/s. Subtracting a 500 ms TTFT gives 66.67 tokens/s. Those are different metrics, and the latter needs aligned clocks and a genuine first-token observation. Historical TTFT zero can also mean unavailable or a submillisecond duration rounded to milliseconds.

**Consequence:** show recorded proxy execution latency, recorded first-response/TTFT with a mixed-provenance limitation, and explicitly named full-latency throughput. Do not label execution latency as complete client-perceived response time across retries. A stronger future contract needs timing start/end semantics and TTFT kind/presence; only then offer generation-window speed. Keep unavailable values null and publish valid-sample counts. Fleet percentiles cannot be averages of instance percentiles; require pooled observations/histograms or show separate percentiles. Define stream/success/failure cohorts before comparing speed.

### 7. The bridge must terminate a different authentication contract

CPA [monitoring handler](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/http/controller/monitoring/handler.go:20) accepts `POST /v0/management/monitoring/analytics` behind panel authorization. In this checkout, [VerifyPanelHeader](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/adminauth/service.go:32) delegates to the stored admin credential and `PanelUsesExternalManagementKey` returns false. A Prox core management key is not automatically a CPA admin credential.

Prox's [repository contract](/home/swerve/src/prox/AGENTS.md:5) uses core v8 management. Its [owned transport policy](/home/swerve/src/prox/src/services/api/transportPolicy.ts:19) rejects absolute destinations and `baseURL`/auth overrides. Do not weaken that policy or inject CPA paths into a core client. CPA's similarly named v0 API is a separate application contract, not permission to add a legacy core fallback.

The existing Prox [server/app.ts](/home/swerve/src/prox/server/app.ts:47) authenticates a quota service against its own key file and serves quota operations. It is a useful server boundary, but not proof of per-instance analytics authorization or an existing CPA bridge. The inspected [quota store](/home/swerve/src/prox/server/quota/store.ts:33) has account/sample tables, with a [five-minute refresh interval](/home/swerve/src/prox/server/quota/types.ts:37); it is not a request ledger.

**Consequence:** explicitly map browser authorization to permitted analytics scope. Keep CPA credentials server-side for the adapter option; use a configured CPA destination and fixed operation allowlist, not caller-supplied upstream URLs. Browser source selection is not authorization. Reject cross-scope instance IDs before querying CPA, including cursor/detail/export access. Cache keys and in-flight requests must include the authenticated scope, source identity, filters and session lifetime. Preserve Prox's existing cancellation/lease behavior. A generic CPA reverse proxy would expose administration and mutation surfaces beyond the requested dashboard.

For direct reuse, an explicit CPA admin session can be legitimate for this admin product. Its broader dataset access must be intentional. A separate credential is not by itself a reason to reject that option.

### 8. “Every request metadata” requires the safe owner projection

CPA has real protections worth preserving: [request-metadata tests](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/request_metadata_test.go:10) cover bounds, controls, absent fields and exclusion from generic event JSON. [Persistence-security tests](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/persistence_security_test.go:423) include secrets embedded in endpoint/path query strings, and the repository calls `PrepareSensitiveFieldsForPersistence`. The [monitoring projection](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:4023) deliberately exposes approved fields and omits raw JSON and failure body.

**Consequence:** use the monitoring owner contract, not `SELECT *`, raw JSON expansion, or browser-side redaction. “Every” means all permitted retained metadata, with missing/truncated/unavailable fields disclosed. Client IP, user agent, account identifiers and correlation hashes also need the authenticated scope, even though they are not plaintext credentials. Server projections must make that decision before serialization. This review found existing defenses; it did not establish a live credential leak.

### 9. Existing coverage and paging are reasons to reuse CPA

CPA [analytics contract](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:117) supports include flags, time ranges, filters and event cursors `(before_ms, before_id)`. [buildAnalyticsCoverage](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:1592) identifies raw deletion, mixed/aggregate-only coverage and feature-specific limitations, including unavailable event details and latency percentiles. Retained aggregates can remain useful after raw data deletion. [Pricing tests](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/pricing_coverage_test.go:191) exercise rebuilding from retained projections and degraded cost availability.

**Consequence:** preserve these omissions and errors rather than converting missing arrays/values to zero. Carry coverage to the relevant chart and request table; an aggregate count may legitimately exceed accessible detail rows. A projection that says nothing was deleted is still not evidence nothing was dropped at ingestion. Stable pagination, filter consistency and chart/table reconciliation are acceptance requirements. The arbitrary maximum page limit is not a reason to request all rows in the browser.

### 10. A downstream service needs a delivery contract, not just a callback

CPA [processItems](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/collector/collector.go:435) inserts events before calling handlers. [UsageEventFanout](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/worker/usage_event_fanout.go:23) invokes handlers in-process; handlers return no acknowledgement/error value. Replayed events already present in the identity ledger are skipped, so simply replaying collector input is not proof a missed downstream delivery will be retried.

**Consequence:** a separate service or platform needs a CPA-owned durable export/outbox or stable retained-data cursor with idempotent sink writes, recoverable checkpoints and retention-aware backfill. That service can own its derived read model; it should not own a fork of CPA's accounting/pricing rules. Raw file sharing would couple it to schema, migrations, privacy policy and retention internals. No measured scale problem in this review justifies that added machinery yet.

## Blockers versus ordinary choices

“Blocker” below means a promise cannot safely ship under the full brief, not that all analytics work must stop.

| Classification | Decision needed |
| --- | --- |
| Blocker for any adapter | Explicit CPA authentication, configured destination, server-authorized scope and safe metadata projection. No second core consumer. |
| Blocker for accurate instance breakdowns | Stable instance attribution persisted and queried in CPA, or verified single-instance store mapping. Mixed historical data stays unattributed. |
| Blocker for accurate execution/parent counts | An owner-defined event cardinality/idempotency contract preserving execution and parent IDs, with a legacy transition policy. |
| Blocker for complete cost totals | Distinguishable missing/partial/free pricing and current-rate valuation labels. A historical-rate promise additionally requires historical rate evidence. |
| Blocker for additive token charts | Canonical disjoint buckets and quality, or a deliberately limited subset display. Unknown usage must not be certified as measured zero. |
| Blocker for precise generation-speed/TTFT claims | Measurement provenance and aligned timing intervals. Existing full-latency throughput can ship under its correct name. |
| Blocker for a downstream store/platform | Durable delivery/checkpoint recovery and a CPA-owned export contract; the callback alone is insufficient. |
| Disclosure requirement | Retained-history bounds, ingestion uncertainty, stale/unavailable sources, archive coverage, missing metadata, unresolved model prices. These do not require inventing a second ledger. |
| Ordinary choice | Initial chart arrangement, time presets, page size, whether provider groups start expanded, and optional comparison views. No UI-scoring exercise belongs in this research. |

## Acceptance probes for the implementation brief

These are local-only probes with synthetic fixtures and dummy credentials. Existing test commands below are executable now; new test names are **proposed and not implemented**. A future harness must create local stores/stubs, never use deployed configuration, real credentials or a live queue. The probes define observable pass criteria rather than claiming gates already exist.

| Probe / proposed test | Executable fixture and pass condition | Owning boundary |
| --- | --- | --- |
| `TestAnalyticsSourceAuthorization` | Stub two instances A/B with distinct sentinel rows and auth scopes. Authenticate only A; request B via filters, details and cursor. Require 401/403 before any B query and no B sentinel in response, errors or caches. CPA admin credential must never appear in browser payloads. Repeat with two route aliases for A; inventory/counts occur once. | Prox adapter plus CPA source query contract |
| `TestUsageExecutionIdentityAndReplay` | Feed local normalization/storage two attempts under one parent with equal hash-input fields but different execution IDs; also an otherwise equal event from B. Require three events, two instance-local parent groups as appropriate, and no extra insertion on exact replay. Exercise multiple usage records per execution and legacy archive import before fixing the unique key. | CPA usage identity and repository |
| `TestAnalyticsTokenPartitionAndUnknowns` | Run the existing v2 fixture: exclusive buckets sum to 234,853, not 467,887. Add included-cache, separate-cache, mirrored-cache, reasoning-subset, total-only, explicit-zero, absent-usage and inconsistent fixtures. API totals must match owner results; partial/unknown quality survives serialization. | CPA accounting/projection |
| `TestAnalyticsPriceAvailabilityAndValuation` | Seed a priced model, an unknown model, an explicitly free model, alias resolution, two provider routes with a shared model ID, and requests around context/service-tier boundaries. Require distinct statuses; unknown is not zero. Change a rate and requery the same historical range: current-rate estimates change and identify the new book; no field claims historical billing. | CPA pricing/monitoring |
| `TestAnalyticsTimingProvenance` | Inject output=100, latency=2000 ms, TTFT=500 ms: full-latency throughput is 50. Add absent/zero TTFT, first-byte fallback, non-stream requests, errors, and TTFT greater than latency. No invalid denominator or unqualified generation-speed value. Check weighted/pooled aggregation against raw samples rather than averaging per-instance p95. | Core timing producer, CPA metrics |
| `TestAnalyticsCoverageDoesNotInventZeros` | In a local store, exercise raw deletion with retained aggregates, missing pricing projection, partial source outage, malformed input and a forced post-pop insert failure using an in-memory fake transport. Preserve owner omissions/errors; distinguish known retained totals, unavailable details and unknown ingress completeness. Never report an outage as zero requests. | CPA ingestion/coverage and adapter |
| `TestAnalyticsSafeMetadataProjection` | Seed fake bearer/API-key text in endpoint queries, errors and headers, plus large/control-character metadata. Require allowed metadata with bounds/redaction, no raw JSON/failure body or sentinel credential in any response/export. Switch source/logout while a deferred response is pending; stale results must not publish. | CPA privacy owner and Prox session/lease |
| `TestAnalyticsPaginationReconciles` | Insert more rows than the page size, with identical timestamps and interleaved instances; traverse `(before_ms,before_id)` under fixed range/filters. Every permitted retained row appears once. Summary totals do not change with page size. Archived aggregate-only rows produce an explicit detail-coverage mismatch, not fabricated rows. | CPA read API and Prox presentation |
| `TestUsageExportCrashRecovery` | Only for options 3/4: interrupt between CPA commit and downstream acknowledgement, restart with the last checkpoint, replay twice. Require every committed exportable event eventually once in the sink, no loss and no duplicated cost. State backfill limits after retention removes exportable detail. | CPA durable export and sink |

Useful existing local baselines, not substitutes for the proposed probes:

```bash
# From the verified Prox repository; executed in this review.
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-env-file --config=/dev/null test tests/sourceRegistry.test.ts tests/sourceSession.test.ts

# From CPA-Manager-Plus/apps/manager-server; inspected tests, NOT executed here.
go test ./internal/usage -run 'Test(NormalizeCacheAccounting|NormalizeRawUsesCanonicalV2BreakdownForIssue941|NormalizeRawSanitizesRequestMetadata|PrepareSensitiveFieldsForPersistenceEndToEnd)$' -count=1
go test ./internal/service/pricing -run 'TestCostForModelDoesNotDoubleBillOpenAICacheMirror|TestCostForGPT56RespectsExplicitZeroPrices' -count=1
go test ./internal/service/monitoring -run 'TestAnalyticsIncompletePricingFailsClosedWithoutCompatibleEvents|TestAccountHistoryDegradesWhenArchivedPricingCannotBeRecovered' -count=1
```

## Checks actually performed and evidence limits

- Read source and named test bodies across all three repositories. Verified cited file paths with `rg --files`. No operational configuration, credentials, databases, queues or deployment endpoints were read.
- Executed the Prox command above with automatic environment-file loading disabled and transpiler cache disabled: **17 passed, 0 failed, 93 assertions**, using Bun 1.4.2. The repository asks for Bun 1.4.3; this result is a narrow source-isolation baseline, not full release validation. Transport adapters/discovery were synthetic.
- Executed a Python `-B` in-memory reproduction of the inspected event-hash fields and an in-memory SQLite uniqueness table: three records differing only by execution or instance produced one hash/retained key. This was source-derived reproduction, **not execution of CPA's Go normalizer/repository**. It establishes the deterministic collision shape; occurrence rates and migration behavior remain untested.
- Parsed the checked-in synthetic v2 token fixture and checked exclusive/naive sums: **234,853 versus 467,887**. Checked the illustrative throughput denominators: **50 versus 66.67 tokens/s**. These are arithmetic counterexamples, not performance measurements.
- Go suites, collector transports, archive jobs, live auth, deployed instance mapping, actual retention periods, provider price freshness and real traffic completeness were not exercised. There is no basis here for a deployment-ready claim or a recovered-history promise.

## Dissent and decision crux

**Dissent preserved:** if this dashboard is intentionally a CPA-wide administrator view, direct API reuse may be the lowest-maintenance choice. Requiring a new adapter merely because an endpoint says v0 would be a manufactured objection. The real reasons for an adapter are source authorization, credential placement, bounded operations and integration with Prox lifetimes. Conversely, an adapter is not a substitute for correcting CPA's missing semantics.

A separate service may become justified by measured CPA query contention, a required retention/search capability, or isolation requirements. No such measurement was made here. An external platform remains a viable secondary consumer of a future durable safe export.

**Crux for the Captain:** can CPA's owning domains expose stable instance/execution identity, safe metadata, explicit cost availability and honest coverage without adding a second usage consumer? The inspected architecture supports extending those owners, but the present API does not already meet all of those promises. Prefer the narrow adapter if Prox must preserve source-specific authority; preserve direct reuse as the simpler choice if a single explicit CPA-admin scope is the accepted product boundary.
