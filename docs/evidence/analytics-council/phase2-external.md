# Prox request analytics — Phase 2 external evidence

**Recommendation:** expose CPA Manager’s retained records through an authenticated, source-aware contract, with CPA Manager remaining the sole queue consumer and the owner of usage normalization and cost calculation. Show **estimated API-equivalent cost**, measurement provenance, and coverage beside the charts. A public price table and a token total alone cannot establish actual subscription spend, historical cost, or generation speed.

Research date: **2026-10-28 UTC**. All external sources below were accessed on that date. This is the external researcher’s Phase 2 report, not the Captain’s final option selection. Public documentation and local source files were read; no production services, usage queues, credentials, databases, other roles’ reports, or browser previews were accessed. No implementation, deployment, commits, or subagents were used. Only this report was written.

## Decisions the evidence supports

1. **Keep raw semantics and normalized accounting distinct.** OpenAI input totals include cache reads and writes; Anthropic’s raw `input_tokens` excludes both. Provider output totals include reasoning. Normalize once at the existing owner, preserve its schema/version and quality, and expose non-overlapping chart buckets. Do not derive a second accounting system in Prox.
2. **Separate cache reads from writes, and writes by lifetime.** Current OpenAI documentation specifies 30-minute and 12-hour write buckets for supported models. Anthropic specifies 5-minute and 1-hour writes. One cache-write rate cannot correctly price every retained request.
3. **Use an explicit rate selection record.** Pricing depends on exact upstream model, billing provider, effective service tier/speed, context band, cache lifetime, modality, and sometimes region or tool usage. A requested alias, provider logo, or model-only rate cannot resolve all of these.
4. **Distinguish current valuation from historical valuation.** A price observed today has an observation date, not automatically a historical effective date. Preserve the selected rate version or price snapshot for future historical estimates; label recomputation of old traffic at current rates separately.
5. **Name timing by what was measured.** First response byte, first stream chunk, first substantive content event, first visible text, and server-generated first token are different observations. Existing `ttft_ms` values need provenance before being pooled into a definitive TTFT chart.
6. **Treat completeness as part of the API.** Missing usage, missing instance identity, missing rate, unavailable timing, and retention gaps must remain distinguishable from zero. Neither an external analytics platform nor a new adapter can recover events that were never retained.

## Provider usage and cost semantics

### OpenAI

The current official documentation is materially more detailed than a simple input/output/cached-input price table. These are observations from fetched pages, not assumptions from older API behavior.

| Concern | Verified rule | Dashboard consequence |
| --- | --- | --- |
| Input | Responses reports `input_tokens`; Chat Completions reports `prompt_tokens`. The prompt-caching guide subtracts cached reads and writes from the input total to obtain ordinary input. [O2, O4, O6] | Cache counts are subsets of the input total. Do not add them to that total again. |
| Cache reads | `input_tokens_details.cached_tokens` counts billed reads and excludes tokens billed as writes. [O2] | Label this “cache read tokens”; it is neither a write count nor proof of application response-cache hits. |
| Cache writes | For supported Responses models, `cache_write_tokens_details.ttl_30m_tokens` and `.ttl_12h_tokens` are non-overlapping and sum to `cache_write_tokens`. The guide states that writes cost 1.25× and 2.5× ordinary input respectively, and are total rates rather than additive fees. [O2] | Retain lifetime buckets. An aggregate write count without the lifetime split may be insufficient for exact API-equivalent valuation. |
| Model differences | The caching guide separates GPT-5.6-and-later behavior from earlier models. The pricing table has models without separate write prices. [O1, O2] | Do not apply the new write rule to every OpenAI model or retrofit it onto unidentified historical traffic. |
| Reasoning | Reasoning tokens are billed as output; the response gives reasoning as a detail of output. [O3, O4] | Do not charge `output_tokens + reasoning_tokens`. Reasoning is a breakdown of billed output. |
| Visible text | Reported output also includes non-visible formatting tokens, which need not be separately itemized. [O5] | `output - reasoning` means non-reasoning output, not necessarily visible answer tokens. Never estimate billed usage from displayed text length. |
| Effective tier | The response’s `service_tier` reports the processing mode actually used and can differ from the request. The current reference says requests using `fast` or `priority` return `priority`. [O4] | Retain requested and effective tier separately; use the effective tier for pricing when known. Do not interpret `auto` as a verified standard tier. |
| Context | The current price page defines short context as ≤272K input tokens and long context as >272K for its short/long tables. Input and output prices can both change. [O1] | Select a request’s context band before aggregation. Do not apply one provider-wide threshold to every model. |
| Tools and modalities | Web search has a per-call charge plus search-content token charges; file search, storage, containers, audio, and images have additional units or rates. [O1] | A text-token estimate may be only a subtotal. Preserve tool units and modality counts when available; otherwise disclose exclusions. |
| Streaming | Chat Completions can emit final whole-request usage with `stream_options.include_usage`. The final usage chunk may be missing if streaming is interrupted. [O6] | A failed or cancelled stream with no final usage is unknown usage, not free usage. Do not sum cumulative usage snapshots across chunks. |

“Prompt input” is the model’s effective input context, including request structure and applicable history, instructions, tool definitions, files, images, and other supported content. The official counting guide explains that roles and boundaries add formatting tokens and local text tokenizers cannot reproduce every request shape. [O5] This research made no token-count API calls. For historical analytics, use retained provider-reported usage; a present-day tokenizer cannot recreate missing hidden reasoning or the original rendered input.

**OpenAI accounting, when the required counts are known:** let `I` be inclusive input, `R` cache reads, `W30` and `W12` writes by lifetime, and `O` inclusive output. Ordinary input is `U = I - R - W30 - W12`. Token cost is:

```text
(U × input_rate + R × read_rate
 + W30 × write_30m_rate + W12 × write_12h_rate
 + O × output_rate) / 1,000,000
```

Rates must already reflect the applicable model/tier/context/region policy. Reasoning is not added again. Tool charges are separate only where the provider’s pricing rules make them separate; avoid charging tokenized tool content twice. Negative residual input or contradictory totals are accounting errors to surface, not values to silently clamp into apparent validity.

### Anthropic

The detailed documentation host returned HTTP 403. Accessible primary evidence came from the official pricing page, official Python SDK, and official cookbook. The SDK and cookbook citations below are pinned to fetched commits. This supports the stated rules, but does not establish that the local collector has retained every field or that every historical Claude model emits them.

| Concern | Verified rule | Dashboard consequence |
| --- | --- | --- |
| Total input | The SDK explicitly defines total input as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. [A2] | Anthropic raw `input_tokens` is ordinary input. Unlike OpenAI, add the separate cache categories to obtain total input. |
| Cache writes | `cache_creation` splits writes into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. [A3, A4] | Preserve both lifetimes; do not add the aggregate creation field after summing its components. |
| Cache rates | The pricing page says displayed writes use 5-minute TTL. The cookbook specifies 1.25× base input for writes, 2× for 1-hour TTL, and reads at 0.1× or less depending on model. [A1, A6] | Read discount is model-specific. A hard-coded “90% discount” is not a complete current rule. |
| Output and thinking | The current SDK says `output_tokens` is the inclusive authoritative billed total. Optional `thinking_tokens` describes internal reasoning and can differ slightly from exact generation counts because it is re-tokenized. [A3, A5] | Thinking is a reported decomposition, never an extra charge on top of output. `output - thinking` only approximates non-reasoning output. |
| Visible content | SDK documentation says usage does not map one-to-one to visible content and output usage may be nonzero even for an empty string. [A2] | Empty answer or missing displayed thinking does not establish zero billable output. |
| Tier and speed | SDK usage contains service tier and speed separately. The pricing page describes batch discounts, fast mode, and US-only inference pricing. [A1, A3] | Preserve these dimensions separately. Do not assume requested settings identify what was served. |
| Context | The accessible current price page explicitly gives Haiku 5.5 different rates above 100K prompt tokens. [A1] | “All Claude requests use a 200K price threshold” is false as a general current rule. Legacy model thresholds require model-specific verification. |
| Tools | The price page lists web search at $10/1K searches, excluding the input/output tokens needed to process requests, and separate code-execution runtime pricing. [A1] | Tool requests and runtime are additional accounting units. A tool name alone cannot establish billable units. |

**Anthropic accounting, with a verified complete TTL split:** `I = U + R + W5 + W1`, and token cost is:

```text
(U × input_rate + R × read_rate
 + W5 × write_5m_rate + W1 × write_1h_rate
 + O × output_rate) / 1,000,000
```

This is a provider-boundary formula, not a prescription to reinterpret already-normalized CPA fields. Before using either formula, establish whether the retained record is raw provider usage, canonical token accounting, or a compatibility payload.

### Small price examples, not a registered-model inventory

The following public observations illustrate the schema requirements. Prices are USD per **1 million tokens**, observed 2026-10-28. They are not promises about a local alias, an OAuth account’s invoice, or a historical effective rate.

| Official model identity / product label | Basis | Ordinary input | Cache read | Cache write | Output | Source |
| --- | --- | ---: | ---: | --- | ---: | --- |
| OpenAI `gpt-5.3-codex` | Standard table | $1.75 | $0.175 | No separate write price listed in this row | $14.00 | O1 |
| OpenAI `gpt-6.1-sol` | Standard, short context | $2.00 | $0.10 | $2.50 / 30m; $5.00 / 12h | $10.00 | O1 |
| OpenAI `gpt-6.1-sol` | Standard, long context | $4.00 | $0.20 | $5.00 / 30m; $10.00 / 12h | $15.00 | O1 |
| Anthropic “Sonnet 4.6” | Public API price row; writes use 5m TTL | $3.00 | $0.30 | $3.75 / 5m | $15.00 | A1 |

The Anthropic marketing label is not asserted to be an exact local API model ID. Even where official model names resemble **Astra** or **Terra**, local aliases must remain **unpriced/unresolved** until an authoritative mapping establishes their exact upstream model and billing basis. No local alias price was inferred here.

For the user’s registered-model table, enumerate authorized configured-source registry entries, then join owner-produced pricing results. Keep registered-but-unused and registered-but-unpriced models visible. Include provider/billing host, instance scope, requested alias, resolved/response model where known, applicable tier/context, input/read/write/output rates, currency/unit, source URL, observed date, effective interval if verified, and match/coverage status. Grouping by provider is presentation; instance identity remains part of the resource identity. Registration itself is not proof of a public price or historical use.

## API-equivalent cost and historical rates

For OAuth subscription traffic, use a label such as **“Estimated API-equivalent cost”**, with the explanation “Retained usage valued at the selected API rate table.” This describes a counterfactual valuation. It does not establish a charge, money saved, remaining subscription quota, or subscription return on investment. Authentication method alone does not establish the commercial billing arrangement; the current vendor pages also describe credits and other plan-specific arrangements.

The owner should distinguish these proposed cost bases:

| Basis | Meaning | Evidence needed |
| --- | --- | --- |
| Provider-reported charge | A retained monetary amount explicitly supplied by the billing provider | Amount, currency, source, scope, and reconciliation limits; final invoice may differ |
| Estimated historical API-equivalent cost | Retained usage valued with a verified rate effective at the request time | Exact matching rule/version or immutable rate snapshot and complete relevant usage |
| Estimated cost at current rates | Old or new retained usage revalued using a selected current table | Table version and valuation timestamp, displayed prominently |
| Partial estimate / unpriced | Some categories, rates, or identifying dimensions are missing | Priced subtotal, known exclusions, unpriced request count, and coverage denominator |

Store price observation time separately from effective-from/effective-to. A web page fetched today does not prove when a price began. An immutable snapshot provides reproducibility; it does not by itself prove the rate was applicable to a past request. A billing provider can also differ from the model vendor: OpenAI’s pricing page explicitly directs Azure and Bedrock users to those services’ prices. [O1]

CPA Manager currently loads model prices during analytics calculation and passes them into its pricing service. That supports treating displayed historical costs as potentially recomputed; it does not prove every analytics path uses identical temporal semantics. See the local evidence below. Before calling any existing total “historical cost,” trace the hourly/preaggregated and raw paths and establish how rates are selected.

Recommended valuation result: amount/currency, cost basis, rate version, selected model/tier/context rule, measured-versus-estimated usage, per-component costs, completeness status, and missing reasons. Aggregate only compatible bases or show them separately. Do not silently include unknown costs as zero in averages. Show “priced requests / retained requests,” and separately show whether retained requests cover all traffic; those are different denominators.

## Timing and speed

The OpenTelemetry GenAI conventions have moved to a separate repository. The fetched revision is **`3fe84604a581b3d50dd5b4bd29383b462d2a5018`**, and these conventions are marked **Development**. Pin the version used for any future integration. Do not describe these names as a stable implemented Prox contract. [T0–T4]

| Measurement | Current primary evidence / proposed local meaning | What Prox can safely claim |
| --- | --- | --- |
| End-to-end inference duration | OTel `gen_ai.client.inference.duration`: request issuance until the response is fully received, error, or cancellation. Logical operation spans include automatic retries. [T1, T3] | A duration needs start/end boundaries and attempt-versus-logical-request scope. Proxy-observed duration is not browser-perceived duration. |
| First byte | Proposed local term: elapsed time to the first upstream response-body byte | It may be a heartbeat, metadata, or an error body. It is not necessarily a generated token. |
| First chunk | OTel `gen_ai.client.inference.time_to_first_chunk`, for streaming calls only. [T1] | A chunk may contain zero, one, or multiple tokens. Preserve this separately from substantive-content timing. |
| TTFT | OTel server metric `gen_ai.server.time_to_first_token`: time to generate the first token for successful responses; model-server metric includes queue/prefill time. [T2] | A proxy cannot label its received first byte as the model server’s generated-token timing. “Proxy-observed first content” is defensible if the event is identified. |
| Inter-chunk delay | OTel `gen_ai.client.inference.time_per_output_chunk`: elapsed time between received chunks after the first. [T1] | It is not per-token generation speed. A terminal timestamp and token total cannot reconstruct the distribution. |
| Full-request token rate | Existing CPA formula: output tokens / full latency in seconds | Label it “output tokens per second over full request.” Preserve its numerator’s accounting semantics. |
| Post-first-content rate | Possible derived estimate only when numerator, timing boundaries, and first-content measurement match | Do not blindly divide inclusive billed output by `latency - ttft`: hidden reasoning may occur before first visible content, tool pauses may intervene, and first chunk may contain multiple tokens. |

Even the ideal `(N - 1) / (t_last_token - t_first_token)` calculation requires `N` to count the same observed generated tokens as the endpoints, at least two tokens, and a positive interval. Retained billed output plus first-byte and request-end timestamps does not supply those observations. Do not offer a precise “decode speed” chart from that data.

For every timing value, the proposed contract should identify observation point, start/end event definitions, stream mode, attempt/request scope, fallback type, and measurement version. Existing TTFT without provenance can be shown as **“reported TTFT; method unspecified”**, with a separate coverage category. Non-streaming TTFT and missing timing should be N/A unless a compatible measurement is actually available. Failed requests retain their latency/error outcomes but should not be mixed into successful generation-speed distributions.

For comparisons, use p50/p95 and sample counts over a consistent cohort, segmented by model, effective tier, context band, streaming mode, and timing method. Do not average per-instance percentiles to produce a fleet percentile. A pooled rate `sum(tokens)/sum(duration)` and the mean of per-request rates answer different questions; name the aggregation. Concurrent requests also mean summed durations are not wall-clock fleet throughput.

OTel’s current token metrics distinguish usage counters from per-operation distribution histograms. Cache-read/write and reasoning counters are subsets of input/output counters, while histograms are for percentiles rather than total cost. [T4] This reinforces the need to avoid summing every token-labelled series in one stacked total.

## Useful Langfuse and Helicone patterns

These are product patterns supported by their official documentation, not independent proof of accuracy on Prox traffic and not a recommendation to replace the collector.

| Pattern | Official evidence | Application to this brief |
| --- | --- | --- |
| Separate reported from inferred usage/cost | Langfuse records ingested or inferred usage and cost by usage type; inference requires a matching model definition. It cannot recover hidden reasoning usage by tokenizing visible content. [L1] | Keep usage provenance and rate-match status visible in request details. |
| Non-overlapping display buckets | Langfuse says each token belongs to exactly one usage bucket; inclusive OpenAI detail fields must be converted before storage. [L1] | Use the existing accounting owner’s exclusive buckets for stacked charts, while retaining provider totals for audit. Langfuse storage semantics differ from OTel inclusive metric subsets. |
| Explicit conditional pricing | Langfuse supports context and parameter/metadata pricing tiers. Inferred costs are calculated at ingestion; updated definitions affect new generations. [L1] | Preserve rule/version provenance. Updating a public table and silently changing all previous dashboard values is a different product choice. |
| One filter model across views | Langfuse dashboards combine metric, dimension, filters and chart type, with model/user/session/time groupings and latency percentiles. [L2] | Time range, instance, provider/model, status and measurement filters should apply consistently to summary, chart and request drill-down. Show any view-specific filter exception. |
| Request/session drill-down | Helicone documents sessions and custom-property segmentation; the request API exposes filters, sorting and pagination, including latency/cost/TTFT sort fields. [H1, H2, H3] | Keep attempt, parent request and session identifiers distinct. Offer bounded request pages behind charts; do not send the entire ledger to the browser. |
| Unsupported cost remains explicit | Helicone describes non-gateway integrations as best-effort estimates and documents missing cost support. [H1] | External tooling cannot justify filling unmapped local aliases with plausible public prices. |
| Stream usage completeness | Helicone’s streaming guide requires usage reporting for accurate cost calculation. [H4] | Missing final usage is a first-class coverage limitation, also explicitly confirmed by OpenAI. |

Helicone’s older cost explainer describes Python-based token estimation for Anthropic. Its newer guide distinguishes gateway calculation from best-effort integrations. [H5, H1] Prefer current provider usage semantics over the older explainer. Its “100% Accurate” gateway heading is a vendor claim; it is not evidence that importing this application’s partial retained records would yield complete billing data.

Helicone’s application response caching can eliminate an upstream call. That is distinct from provider prompt/KV caching, where a request still runs and cached-input tokens are billed. Keep these cache concepts separate. [H1, O2, A6]

A compact dashboard research direction follows from these patterns: token trends using exclusive categories; estimated-cost trends with rate basis and exclusions; model/provider/instance breakdowns; latency distributions with timing coverage; and a paginated request table with safe detail projection. Include unknown/unclassified categories rather than silently excluding them. Chart click-through should reproduce the exact denominator and filters. No visual quality scores were assigned.

## Local contract checks and implications

All paths in this section were verified with `rg`/`rg --files` and read in this turn. Line references describe the working checkout at research time, not an immutable commit or production deployment. Other work was left intact.

| Verified source | Finding and implication |
| --- | --- |
| [Prox repository guidance](/home/swerve/src/prox/AGENTS.md:1) | Prox uses the v8 core Management API. CPA Manager’s separate analytics API must not become a legacy-core v0 fallback. |
| [Core queue handler](/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/usage.go:23), [queue retention constants](/home/swerve/src/CLIProxyAPI/internal/redisqueue/queue.go:10) | `GetUsageQueue` calls `PopOldest`; default retention is 60 seconds, maximum 3600. No analytics reader should consume this queue independently of CPA Manager. Nothing here establishes historical completeness. |
| [Core usage payload](/home/swerve/src/CLIProxyAPI/internal/redisqueue/plugin.go:150) | Payload includes accounting version/breakdown, request and execution IDs, session and parent-session IDs. Preserve identity distinctions through any retained-data projection; they support separating attempts from user operations. |
| [Core accounting owner](/home/swerve/src/CLIProxyAPI/sdk/cliproxy/usage/accounting.go:5) | Schema v2 already defines exclusive input/read/write and non-reasoning/reasoning output buckets, plus complete/inconsistent/unclassified quality and invariant checks. Extend and consume this contract; do not invent a competing Prox normalization. TTL-specific writes are not present in the inspected breakdown struct. |
| [CPA event contract](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/event.go:17) | Retains requested/resolved/response model, request/response service tier, stream/session data, normalized cache buckets and optional latency/TTFT. Searches found no `execution_id` or proxy-instance field in this file. This is an identified contract gap, not proof that all storage layers lack an alternative representation. |
| [CPA source identity rules](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/usage/RULES.md:1) | `Source`/`SourceHash` serve credential/account corroboration. They do not establish the logical proxy instance. Do not relabel them as instance identity. |
| [Extra collectors](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/worker/extra_collectors.go:14) | Extra upstream collectors write into the same store. Fleet attribution therefore requires durable upstream/instance identity, not an assumption that one store equals one proxy. |
| [CPA price repository](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/repository/modelprice/repository.go:67), [price rules](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/model/model_price_rules.go:23), [pricing service](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/pricing/cost.go:185) | Prices are loaded into a map keyed by model; context and service-tier rules already exist. Model-only identity can collide across billing providers. Extend the existing owner rather than duplicating its rules in an adapter or chart component. |
| [Analytics rate loading](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:1045), [cost delegation](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/service/monitoring/service.go:4615) | Analytics uses snapshot prices or loaded model prices and delegates cost calculation to pricing. This is not evidence of immutable per-request historical charges. Temporal behavior needs explicit verification before the UI makes that claim. |
| [CPA analytics handler](/home/swerve/src/CPA-Manager-Plus/apps/manager-server/internal/http/controller/monitoring/handler.go:20) | Calls `AuthorizePanel`, then routes `/v0/management/monitoring/analytics` as POST. It is a separate panel-authenticated owner API, not the deprecated core API. Core management credentials are not automatically an authorization contract for it. |
| [Core timing helper](/home/swerve/src/CLIProxyAPI/internal/runtime/executor/helps/usage_helpers.go:381), [fallback selection](/home/swerve/src/CLIProxyAPI/internal/runtime/executor/helps/usage_helpers.go:749) | Supports substantive token events, first-response-byte tracking, and first-packet fallback. A bare `ttft_ms` does not identify which occurred. |
| [CPA displayed rate formula](/home/swerve/src/CPA-Manager-Plus/apps/web/src/features/monitoring/model/eventRows.ts:21) | Uses output tokens divided by full request latency. Reusing it as post-first-token speed would mislabel the measurement. |
| [Prox source rules](/home/swerve/src/prox/src/domain/providerSources/RULES.md:1), [source registry](/home/swerve/src/prox/src/services/providerSources/registry.ts:36), [source sessions](/home/swerve/src/prox/src/services/api/sourceSession.ts:51) | Logical instance IDs, explicit auth scopes, authenticated registry ownership, epochs/generations and stale-session checks already exist. Analytics should preserve these lifetimes and source scopes rather than create another inventory or credential-sharing rule. |

The safe metadata projection belongs at CPA Manager’s authenticated owner boundary. The event contract explicitly keeps downstream client metadata out of compatible payloads and identifies failure bodies as sensitive internal fields. “Every request metadata” should mean all available, authorized operational fields plus explicit unavailable fields—not raw event maps, secret-bearing query strings, credential values, or unrestricted failure bodies. OTel likewise treats prompts, outputs and tool content as opt-in sensitive content. [T3]

These local checks favor either direct authenticated reuse of CPA’s API or a narrow Prox-facing adapter if auth/source projection requires one. External evidence cannot settle the deployment-specific choice without the other research roles’ findings. A dedicated service should not become a second accounting owner or queue consumer. An external observability platform would require a separate justified export/integration design and would inherit existing retention and measurement gaps.

## Acceptance examples for the Captain’s implementation brief

These are proposed acceptance cases, not tests implemented or executed in this research.

- **OpenAI cache partitions:** the official guide’s example has 12,000 input, 4,000 reads, 3,000 30m writes, and 4,000 12h writes. Ordinary input is 1,000. At its illustrative $1 input/$0.10 read rates, input cost is **$0.01515**. Summing input plus cache details is incorrect. [O2]
- **Anthropic cache partitions:** a synthetic request with 1,000 ordinary input, 8,000 reads, 2,000 5m writes, 1,000 1h writes and 1,000 output has 12,000 total input. At the observed Sonnet 4.6 standard rates, with the cookbook’s 2× 1h write rule, its estimated token cost is **$0.0339**. Mark this a constructed fixture, not observed traffic. [A1, A6]
- **Reasoning:** 1,000 inclusive output and 600 reasoning means 1,000 billed output, with 400 non-reasoning. Do not charge 1,600; do not promise 400 visible text tokens. [O3, O5, A3, A5]
- **Missing TTL:** a nonzero write total without the lifetime split is partial pricing when the possible lifetimes have different rates. A historical configuration assumption must be stated and scoped, never silently treated as measured.
- **Context/tier:** boundary values immediately below, at, and above each model’s threshold select the documented band; requested `auto` does not override an effective fast/priority result. Verify whether service/context overrides compose correctly in the existing owner.
- **Interrupted stream:** failure with absent final usage remains an error with unknown cost/usage; a known explicit zero remains zero. Exclude unknowns from measured-value averages and report their count.
- **Identity and duplicates:** two instances using the same credential label remain separate; two attempts of one request remain distinguishable. Imported duplicate records must not inflate totals. Historical records lacking instance identity stay unattributed unless evidence resolves them.
- **Historical valuation:** changing a current rate changes only the explicitly selected current-rate valuation. A preserved historical rate snapshot remains reproducible. Missing effective-date evidence prevents the “historical rate” label.
- **Timing:** a heartbeat before substantive output produces a different first-byte/first-chunk result from first-content timing. A one-chunk response does not yield reliable inter-token speed. Retry duration has a declared request/attempt scope.
- **Coverage and authorization:** summary, chart and drill-down agree for the same authorized source/time/filter set. Unavailable sources remain represented. Logout/reconnect invalidates old requests. Sensitive internal fields never enter the public projection.

Before implementation, the remaining decisive questions are whether retained records preserve schema-v2 accounting and cache TTLs end to end; how each historical timing value was measured; how records identify originating proxy instances and attempts; whether CPA’s existing rate rules can represent billing-provider and effective-date distinctions; and which owner-projected metadata/auth contract Prox can use. These are contract questions, not reasons to fabricate backfill.

## Primary source register

All entries were fetched on **2026-10-28 UTC**. Supporting extracts are short quotations from the fetched source. Public pages can change; GitHub sources are pinned where noted. Public documentation access is not a production/API usage call.

### OpenAI

- **O1 — Pricing:** https://developers.openai.com/api/docs/pricing.md — HTTP 200; HTML page https://developers.openai.com/api/docs/pricing also fetched successfully. Extracts: “Prices per 1M tokens”; “Short context: ≤272K input tokens. Long context: >272K input tokens”; “Tokens used for built-in tools are billed at the chosen model’s per-token rates.” Supports the observed rate rows, tier/context distinctions, tool units, regional uplift, and separate cloud-platform billing.
- **O2 — Prompt caching:** https://developers.openai.com/api/docs/guides/prompt-caching.md — HTTP 200. Extracts: “Cache-write pricing is not an additive fee”; “These counts do not overlap and sum to `cache_write_tokens`”; “Do not add `cache_write_tokens` again after counting its two components.” The page explicitly names `ttl_30m_tokens` and `ttl_12h_tokens` and supplies the $0.01515 example.
- **O3 — Reasoning:** https://developers.openai.com/api/docs/guides/reasoning.md — HTTP 200. Extract: reasoning tokens “are billed as … output tokens.” It also documents incomplete responses that incur reasoning usage before visible output.
- **O4 — Responses create reference:** https://developers.openai.com/api/reference/resources/responses/methods/create.md — HTTP 200. Extract: the response tier “may be different from the value set in the parameter.” Usage documents input details, cache writes/reads and reasoning output details. The fetched guide O2 supplies more explicit write-lifetime detail than the inspected reference excerpt; implementation should verify actual supported upstream schema/version.
- **O5 — Token counting:** https://developers.openai.com/api/docs/guides/token-counting.md — HTTP 200. Extracts: “The count includes formatting tokens used to represent request structure”; “Reported output token usage includes all tokens generated by the model, not only the text visible in a response.” No endpoint on this page was invoked.
- **O6 — Chat Completions create reference:** https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create.md — HTTP 200. Extract: “If the stream is interrupted, you may not receive the final usage chunk.” Supports final-usage coverage limits and the older field names.

### Anthropic

- **A1 — Official pricing:** https://www.anthropic.com/pricing — HTTP 200 with final URL https://claude.com/pricing when fetched with a standard browser user-agent string. Direct requests to the final URL also produced 403; the successful redirect response is the evidence used. Extracts: “Prompt caching pricing reflects 5-minute TTL”; “Save 50% with batch processing”; web search “Doesn’t include input and output tokens required to process requests.” The displayed current and legacy API rows establish only observed public prices.
- **A2 — Official SDK Message usage:** https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/202db72c87d7c6eaa72129c67ce67fd343a3a20c/src/anthropic/types/message.py — HTTP 200. Extract: “Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.”
- **A3 — Official SDK Usage:** https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/202db72c87d7c6eaa72129c67ce67fd343a3a20c/src/anthropic/types/usage.py — HTTP 200. Extract: “`output_tokens` remains the inclusive, authoritative total used for billing.” Also defines optional service tier, speed, geography, cache creation and server tool usage fields.
- **A4 — Official SDK cache creation:** https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/202db72c87d7c6eaa72129c67ce67fd343a3a20c/src/anthropic/types/cache_creation.py — HTTP 200. Extracts: “The number of input tokens used to create the 1 hour cache entry”; corresponding 5-minute field.
- **A5 — Official SDK output details:** https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/202db72c87d7c6eaa72129c67ce67fd343a3a20c/src/anthropic/types/output_tokens_details.py — HTTP 200. Extract: “`output_tokens - thinking_tokens` approximates the non-reasoning output.” The comment explicitly describes re-tokenized raw reasoning rather than returned summary text.
- **A6 — Official prompt-caching cookbook:** https://raw.githubusercontent.com/anthropics/anthropic-cookbook/bfe50e59dbb4f5546a0af9ca36ebb77e637c9ce1/misc/prompt_caching.ipynb — HTTP 200; notebook markdown read without execution. Extracts: “A 1-hour TTL is available at 2x base input price”; “Cache writes cost 1.25x base input price. Cache reads cost 0.1x base input price or less, depending on the model.”

### OpenTelemetry

- **T0 — Official relocation notice:** https://raw.githubusercontent.com/open-telemetry/semantic-conventions/main/docs/gen-ai/gen-ai-metrics.md — HTTP 200. Extract: “GenAI semantic conventions have moved to the OpenTelemetry GenAI semantic conventions repository.” The old website URL https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/ returned 200 but is not the pinned normative source used below.
- **T1 — Client inference:** https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/3fe84604a581b3d50dd5b4bd29383b462d2a5018/docs/gen-ai/client-inference.md — HTTP 200, Development. Extracts: duration ends when “the response is fully received or the operation ends with an error or cancellation”; first-chunk metric “SHOULD be reported for streaming calls and SHOULD NOT be reported otherwise.”
- **T2 — Server metrics:** https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/3fe84604a581b3d50dd5b4bd29383b462d2a5018/docs/gen-ai/gen-ai-metrics.md — HTTP 200, Development. Extracts: TTFT is “Time to generate first token for successful responses”; time-per-output-token is for tokens “generated after the first token.” The generic client operation-duration metric is no longer the recommended metric for inference in this revision.
- **T3 — Spans and content:** https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/3fe84604a581b3d50dd5b4bd29383b462d2a5018/docs/gen-ai/gen-ai-spans.md — HTTP 200, Development. Extracts: logical-operation span includes “all retries”; prompts/outputs “SHOULD NOT” be captured by default, with explicit opt-in available.
- **T4 — Inference token metrics:** https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/3fe84604a581b3d50dd5b4bd29383b462d2a5018/docs/gen-ai/gen-ai-token-metrics.md — HTTP 200, Development. Extract: “The `cache_read`, `cache_write`, and `reasoning` counters report subsets of the `input_tokens` and `output_tokens` counters.” Per-operation histograms “should not be used for total usage or cost calculations.”

### Langfuse and Helicone

- **L1 — Langfuse token/cost tracking:** https://langfuse.com/docs/observability/features/token-and-cost-tracking — HTTP 200. Extracts: “each token must be counted in exactly one key”; “inferred costs are calculated at ingestion time”; “updated defaults apply only to new generations.” Supports exclusive buckets, inference limits and conditional pricing patterns.
- **L2 — Langfuse dashboards:** https://langfuse.com/docs/metrics/features/custom-dashboards — HTTP 200. Extracts: “Metrics: Select what to measure”; “Dimensions: Group by user, model, time, trace name”; “Latency Analysis: Track P95 and P99 response times.”
- **H1 — Helicone cost tracking:** https://docs.helicone.ai/guides/cookbooks/cost-tracking.md — HTTP 200. Extract: direct integrations provide “best-effort cost estimates based on model detection and token counts.” Also documents sessions, segmentation, unsupported costs and application response caching. Its gateway accuracy claim was not independently validated.
- **H2 — Helicone custom properties:** https://docs.helicone.ai/features/advanced-usage/custom-properties.md — HTTP 200. Extract: “Calculate costs and metrics grouped by properties.” This is a useful filter/drill-down pattern, not permission to export arbitrary local metadata.
- **H3 — Helicone request-query documentation:** https://docs.helicone.ai/rest/request/post-v1requestquery-clickhouse.md — HTTP 200. Contains filter, limit, offset, sorting and request schema documentation. Only the documentation was fetched; the described request API was not called.
- **H4 — Helicone stream usage:** https://docs.helicone.ai/faq/enable-stream-usage.md — HTTP 200. Extract: `stream_options` with `include_usage: True` for streaming cost calculation.
- **H5 — Helicone older cost explainer:** https://docs.helicone.ai/references/how-we-calculate-cost.md — HTTP 200. Extract: “we estimate the cost based on the model returned in the response body.” Its Anthropic token-estimation passage is insufficient authority for current provider accounting.

### Unavailable or limited evidence

- HTTP **403**: https://platform.claude.com/docs/en/about-claude/pricing and its `.md` form; https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md and the same page with `?format=markdown`; https://docs.anthropic.com/en/docs/about-claude/pricing; https://docs.claude.com/en/docs/build-with-claude/prompt-caching. No claims are based on unread bodies. Official SDK/cookbook/pricing evidence above provides the stated alternatives; exhaustive legacy thresholds and commercial exceptions remain unverified.
- HTTP **404**: https://docs.helicone.ai/use-cases/cost-and-latency-analysis and https://langfuse.com/docs/observability/features/metrics. Correct accessible sources H1/H3 and L2 were used instead. No latency formula is attributed to those failed URLs.
- Initial guessed root-level GenAI paths in the new OTel repository returned 404. The official GitHub tree identified `docs/gen-ai/`, and all cited pinned paths were subsequently fetched successfully.
- No public search tool was exposed. Python standard-library HTTPS fetches were used; no browser was opened and no package was installed. Source extracts and pinned revisions provide the review trail, not cached full-page artifacts.
- No production retention/coverage, complete registered-model inventory, private price contract, subscription billing allocation, deployed auth compatibility, or historical effective-rate table was verified. These cannot be inferred from public documentation or static source alone.

## Report validation

Verified all 20 local citation targets with `rg --files` and checked their line numbers against the current files. Checked Markdown fence balance and trailing whitespace. Recalculated both cost examples with Python decimal arithmetic: $0.01515 and $0.0339. No application tests were run because this task produced research only; the acceptance cases above remain proposals.
