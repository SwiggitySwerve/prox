# Phase 3 — omo-delphi cross-attack

## CRUX

**Modified; retain option 4 with scoped clients.** The decisive boundary is whether a resource and its entire operation retain one owner through asynchronous work. A manifest alone does not establish that boundary. Momus's failures are valid objections to a shallow implementation, not reasons to introduce a general relay.

I withdraw Phase 2's requirement that missing universal allowance identity disable existing provider pools. It would change the established product contract and could unnecessarily remove working Claude results. Preserve source-local, unweighted credential-normalized percentage points and their existing quality rules. Do not introduce a numeric cross-source same-provider pool in this change. Universal allowance discovery is a separate bounded change, not a prerequisite for fixing visibility.

I also narrow plugin support: a declared initial resource URL is insufficient. An unproven embedded resource remains visibly unsupported for that source; management, inventory and supported actions can still work. No new DNS, listener, certificate or deployment authority is assumed.

## RESPONSE

### 1. Minimum enforceable ownership contract

Phase 2 named the right seam but did not specify enough enforcement. Extend the existing transport and domain modules, with the following **proposed API**, rather than swapping the singleton around requests:

```ts
type Owner = Readonly<{
  instanceId: string;
  sessionEpoch: number;
  sourceGeneration: number;
}>;

interface SourceSession {
  readonly owner: Owner;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  // Pinned transport; credentials are private, no setConfig or default owner.
  readonly management: ScopedManagementTransport;
  readonly catalog: ScopedCatalogTransport;
}

captureSource(instanceId: string): SourceSession;
createAuthFilesApi(session: SourceSession): AuthFilesApi;
createModelsApi(session: SourceSession): ModelsApi;
// The same required argument applies to other domain API factories.

// Owned by the initiating feature: confirmation, draft, attempt or read task.
type Operation = Readonly<{
  session: SourceSession;
  operationId: number;
  assertCurrent(): void;
}>;
```

These are design names, not symbols claimed to exist today. The source-contract owner defines descriptors, aliases and stable instance IDs; `src/services/api/client.ts` owns transport/session enforcement. Features own operation lifetimes. The registry does not own provider rules or quota arithmetic.

- **Never reuse generations.** An application logout/login creates a new session epoch, even with identical credentials. Replacing a source's endpoint, authentication or routing configuration, removing/re-adding it, or reauthenticating it advances its generation. A display rename need not invalidate transport. A→B→A configuration restoration cannot revive old work. Source identity is not provider kind, URL or generation; a different logical backend must not inherit an old identity/history merely because it occupies the same port.
- **Pin the full chain.** Capture the session when the operation begins, including when a confirmation opens. Every nested request, page, retry, cleanup and poll receives that same session or its bound API. Recheck at queue dequeue, immediately before transport dispatch, after each await before dependent work, and before publishing a result. Abort is best effort; the guards remain necessary. A missing/stale owner produces an explicit error, never a lookup of the selected/default source.
- **Separate source lifetime from UI intent.** Selecting B does not reconfigure A's transport. For source-selected editors and destructive dialogs, changing destination invalidates the operation ID immediately, including selection A→B→A. A retained draft must be reopened/revalidated explicitly. An OAuth attempt may remain alive independently of the visible filter, but its immutable owner and attempt ID govern start/status/callback/cancel. No cleanup reacquires a newer session under the same ID. Preserve existing captured cleanup only where its contract permits it; otherwise report that cleanup was not confirmed.
- **Publication is owned too.** Version, plugin capability, authentication, inventory-change and plugin-refresh events include the owner tuple; receivers reject obsolete tuples. A current B management 401 marks B unauthorized without logging out A. A client-catalog 401 concerns that source's client credential, not its management session. Preserve primary/external application-session logout semantics through an explicitly scoped compatibility adapter. Suppress stale headers and 401s before they reach stores. Caches, in-flight maps and invalidations use owner plus local resource/arguments; feature result publication additionally checks operation ID.
- **Queues cannot hide ambient state.** OAuth map writes serialize by owner plus config path. Reads, sibling preservation, writes and invalidations use the same session; stale queued work rejects before its first request. Preserve full-config TTL/deduplication per owner. Model discovery includes owner in in-flight identity and uses the bound API-call client for every Gemini page and enrichment step. Plugin mutation passes its bound plugins/store API and operation into post-mutation polling; every delayed poll checks both. Config preview/save/recovery shares the captured owner and operation, including each sequential patch step.
- **No fallback escape hatch.** Scoped domain implementations and their transitive request helpers must not import the ambient singleton or accept an optional session default. The bound transport rejects URL/base overrides that escape its declared source routes; explicit upstream URLs inside authorized API-call payloads retain their existing contract. A temporary single-source facade may capture an explicit external/primary owner at the outer boundary and call the same implementation. An import/dependency check must prevent scoped implementations from reaching ambient exports, alongside behavioral tests; a naming convention alone is not enforcement.

An already-dispatched mutation cannot be undone by invalidation. If its result is lost or superseded, record an outcome requiring reconciliation under its original owner; do not claim failure, success, rollback or retry on another source. Bulk confirmation freezes source-qualified targets, groups them by captured owner and preserves success/failure/unknown outcomes. Added sources are excluded. Incomplete inventory prevents claiming “all configured sources”; an explicitly selected complete subset remains usable. Backend `all=true` remains a separately worded single-source action.

**Code verification:** `client.ts:39,60,150,187` has mutable configuration, captured transport and unqualified response events; `useAuthStore.ts:243` consumes those globally. `authFiles.ts:314` defaults a malformed inventory to an empty array and groups before normalization; `useAuthFilesData.ts:322` resolves deletion inside a delayed confirmation. `authFiles.ts:463` keys OAuth queues by global revision; `configValue.ts:4,24` still uses the singleton. `models.ts:17,218,277` omits management ownership from signatures and uses ambient API-call during discovery. `pluginPolling.ts:29,54` imports ambient APIs for its loops. These paths/symbols were checked in this turn. The proposed contract covers each; none is fixed by this report.

### 2. Smallest truthful quota policy

`server/quota/RULES.md:8` explicitly defines 100 unweighted normalized points per enabled account, not tokens or equal subscription budgets. `domain.ts:303` implements that denominator. Preserve that **source-local observation contract**, including the existing stale/missing/error/forecast conditions. A missing Claude organization/account identifier must not become a new failure condition for an otherwise valid existing observation or source-local forecast.

The initial policy is deliberately smaller than Phase 2's entitlement proposal:

| Scope | Result in this change |
| --- | --- |
| Existing one-source provider pool, no confirmed duplicate issue | Same normalized-point values, measured rates, recorded history and forecast eligibility as before. Label the source and retain the existing unit explanation. No claim of independent upstream budgets. |
| Multiple same-provider sources | Show separate source-local pools and all credential occurrences. The combined result says `cross-source-combination-unverified`; combined capacity, remaining points, rates and forecast dates are null/unavailable, with no combined projected or recorded sum. Occurrence counts remain numeric and explicitly named as such. Do not select one source's number and label it “All.” |
| Confirmed repeated account across sources | Keep both observations and histories, mark the confirmed relationship when available, and keep the combined numeric result unavailable. Per-source panels describe that source's observations, not additional independent capacity. No sum of their denominators. |
| Confirmed duplicate membership inside one source-local pool | Preserve individual observations/history, but suppress that affected pooled arithmetic/forecast with a duplicate-membership reason until a separate explicit membership/exclusion rule resolves it. Do not introduce a representative-switching algorithm or keep presenting a known duplicated pool as usable capacity. Other source-local pools remain usable. |
| Equal emails, filenames, plans or auth indices without confirmed relationship | Do not merge or classify accounts as duplicated. Unknown identity alone does not disable the established source-local statistic. |

“Confirmed” requires specific, trustworthy evidence for the relationship asserted; an account identifier alone is not proof that all its window families share an allowance. No such live relationship was established by this review. Synthetic relationship inputs test the guard; they are not production discoveries. The first release need not discover every duplicate to avoid introducing new double counting: **it never adds multiple source-local pools together**. Provider/window-specific identity discovery and any future cross-source summation require a separate quota-domain change with evidence and tests. No profile request or credential download is added merely to populate universal entitlement IDs.

This rule belongs in **`server/quota/RULES.md` and `server/quota/domain.ts`**, with the public result contract in `src/domain/quotaPool/types.ts`. Add an explicit aggregate availability/reason envelope; do not turn null into zero or silently reuse today's required numeric `capacityPoints` for an unknown aggregate. Keep available source-local `QuotaPool` results intact. Rendering displays server decisions; the manifest never decides allowance equivalence. The existing Claude/Codex window converters remain authoritative.

History still requires the source migration described in Phase 2. `collector.ts:91` hashes provider/index, `store.ts:92` retires by provider, and samples reference those IDs. Change retirement to a validated complete **instance/provider** inventory, enumerate mixed-provider sources once, and preserve membership on timeout, 401, malformed or incomplete responses. Only a complete empty inventory retires that source's applicable rows. Pin collector cycles to a manifest revision and reject obsolete writes after source reconfiguration, just as browser generations reject late publication.

Use explicit legacy deployment provenance to attribute existing Codex8317/Claude8319 rows, retain their account IDs and sample foreign keys, and use source-qualified IDs for new occurrences. An unmapped legacy database retains unresolved history rather than guessing from names/emails. Migration preserves every sample tuple and first-observation timestamp, with transaction rollback, reopen/idempotence and foreign-key tests. No backfilling, new synthetic depletion intervals, retention purge or history reset. Existing default single-source output fixtures must compare identically before and after attribution. Unknown cross-source aggregation does not erase any source's historical series.

### 3. Plugin transport acceptance boundary

The deployment manifest must distinguish management base, client-catalog endpoint, authenticated custom-extension paths and unauthenticated browser resource routes. Each plugin resource declaration needs **instance ID, browser origin, public prefix, preserved backend prefix/path, and supported routing mode**. Compatibility evidence is tied to the plugin artifact/version and route configuration; a plugin update invalidates old evidence. Backend menu metadata alone does not prove compatibility or authorize new destinations. Keep plugin-store `sourceId` as registry provenance, separate from instance ownership, and retain existing installation trust checks.

Two modes are acceptable, both explicit:

1. **Verified prefix-compatible resource:** every required document, script, asset, fetch and redirect resolves within the declared source-owned route set. Relative requests and explicitly source-prefixed absolute paths can qualify. A root-relative `/v0/resource/plugins/...` request from a page under `/claude/...` escapes that prefix and fails this mode unless its complete routing is unambiguously declared to the same source. On a shared origin, overlapping root ownership is rejected; do not rely on Referer, cookies or the active selector to choose an upstream.
2. **Verified source-dedicated resource origin:** root-relative requests can retain source ownership when that browser origin already exists and its declared paths route only to that instance. The manifest can represent this configuration; it does not create DNS, TLS, ports or LAN reachability. No such deployed origin has been proven here. If none is available, an origin-root-dependent plugin is unsupported in the new multi-source surface.

Default for an unproven embedded plugin page: show its source, plugin and “resource transport unsupported,” and do not create the iframe. Keep its supported management inventory/configuration/actions accessible. Do not silently fall back to the primary instance or automatically open an unverified direct URL. Existing explicit external single-backend resource behavior and third-party trust rules remain; an absolute third-party URL is not evidence of a source-owned transport and never receives management credentials.

Generated Nginx routes use fixed validated upstreams and exact paths/bounded prefixes, preserving declared backend paths, query/body/status and required headers. No caller-supplied upstream URL, broad new inference route, unrestricted relay, HTML rewriting or management-key injection into browser resources. Catalog routing exposes the required models endpoint using its source's client credential. Management credentials remain scoped browser input. Resource origins are not automatically authorized management credential destinations.

**Fixture acceptance:** A/B return the same plugin/menu IDs but distinct body markers. Test the initial document, relative assets, source-prefixed fetches, root-relative fetches and redirects; supported cases all retain the owner. A prefix-escaping fixture must fail compatibility and render the unsupported state, with zero resource dispatch to the ambient root/default backend. Test overlapping origin/prefix declarations and unknown paths as rejections, plus custom extensions, catalogs with distinct fake client/management keys, multipart upload and raw download. Transport tests must exercise generated routes, not only compare URL strings. Later browser execution is required to certify a concrete dynamic plugin; a fixture or static scan cannot certify every deployed plugin.

This can be implemented and fixture-tested using synthetic endpoints without allocating deployment authority. Unsupported plugin embedding does not block the inventory prototype. Verified code: `pluginResources.ts:27` only prefixes the initial URL; `PluginResourcePage.tsx:88` selects it for an iframe; `deploy/nginx.conf:30–55` has management/history routes and a static catch-all. Backend `server_management.go:255` separates custom extensions/resources, and `internal/pluginhost/management.go:296` serves unauthenticated resource GETs. Management success therefore cannot certify plugin support.

### 4. Discovery is not credential export or permission to execute adapters

The source contract has three separate boundaries:

- **Public deployment discovery:** construct an allowlisted descriptor from validated deployment configuration only: IDs, labels, revision, browser routes, non-secret auth-scope names and support declarations. Omit credential references, upstream-only configuration and all backend inventory/config/usage payloads. Never spread a backend response into discovery. A label is operator configuration, not a copied account field.
- **Authenticated resource reads:** keep existing authorized account management usable, but return purpose-specific source-qualified view data. Fields needed only for existing authorized operations stay inside that authenticated flow. Raw inventory is not a log/evidence/debug serialization format. In particular, do not use generic `account` as a label, identity fallback, public cache key or error detail. Preserve any existing private dashboard comparison that needs it within its owning operation, then project the result. Explicit credential downloads and mutations retain their current authorization and response handling.
- **Execution:** registry enumeration fetches discovery/inventory; it does not dispatch quota adapters. Aggregate refresh must not mean “run every provider adapter.” The pooled collector keeps its explicit supported Claude/Codex observation contract. Detailed quota execution retains the existing explicitly selected/authorized action scope and receives captured targets; adding a source cannot silently enlarge that scope. Inventory and source selection must not trigger xAI paid-health fallback, credential downloads, refresh/usage queues, reset/grant actions or inference. Existing explicit xAI checks remain available through their current action semantics and bound source; this change neither silently runs nor removes them.

This is based on code, not hypothetical leakage: `auth_files.go:709` assigns `AccountInfo()` to listing `account`; `sdk/cliproxy/auth/types.go:788` can return the actual API key. `src/features/quota/providers/xai/data.ts:107` sends a one-token chat POST; `fetchXaiQuota` can reach it after unavailable billing. The management API-call outer POST is not itself sufficient to classify safety; tests inspect its nested method, URL and payload.

Enforce with synthetic sentinel tests: inventory contains fake secrets in `account`, nested token-like metadata and error bodies; public discovery, view DTOs, diagnostic events and evidence serialization contain none. Assert exact allowed descriptor fields, not a blacklist of secret field names. Spy on all adapter/API-call/download/mutation seams while enumerating a mixed-provider inventory and refreshing aggregate inventory: no adapter execution and no queue consumption. Then exercise a deliberately authorized xAI action and show its existing request chain stays on the selected captured owner. A shared DTO cannot be made safe by adding `instanceId` to a raw credential-bearing response.

### 5. First vertical slice and implementation boundaries

**Decision: proceed with option 4 plus scoped clients; no unresolved fact blocks the synthetic prototype.** The following is the dependency order, not approval to edit application code in this review:

1. **Consolidate without behavior change.** Introduce one validated descriptor owner and manifest-to-routing/discovery/collector input seam; extract session-injected API implementations behind the existing one-source facade. Preserve existing guards, normalizers, provider descriptors and quota converters. Compare current one-source outputs and regression tests before adding behavior. Do not mix this refactor with source migration or arithmetic changes.
2. **Prove transport/session ownership and visible Auth Files.** Generate routes for synthetic A/B (same provider) and C (mixed providers); expose source-qualified rows and one targeted mutation. Strictly validate successful inventories before normalization and normalize per source. Add per-source completeness/errors and owned event/cache handling. Run the acceptance probes below before migrating the remaining surfaces.
3. **Migrate consumers through the same contracts.** Providers/Dashboard/layout counts and menus; then selected-source config/editor/log/OAuth/System/catalog flows, plugin actions/polling/resources, and detailed quota. Include navigation, refresh listeners, background helpers and stores. Do not leave a correctly tagged page feeding ambient helpers. Preserve the existing visual branch rather than redesigning it.
4. **Migrate collection/persistence and expose source-local pools.** Apply the explicit legacy mapping, source-scoped retirement and revision-bound collection. Preserve current Claude/Codex normalized results/history; add cross-source-unavailable and duplicate-membership states in the quota owner. Identity discovery and an independent-allowance aggregate are excluded from this change.
5. **Verify integration before deployment.** Focused tests then repository verification and later authorized browser/transport checks. Audit remaining singleton imports, generated revision agreement and unsupported capabilities. Production migration, live credentials and deployment validation occur only in their separately authorized implementation phase.

The first slice must pass these **acceptance tests**, including nested operations even before their full UI migration:

| Test | Required observation |
| --- | --- |
| A/B colliding filename/index; C mixed provider; root and `/codex` alias A | Every occurrence survives per-source normalization; aliases enumerate once. A's cache invalidation and physical-file mutation do not touch B; existing Devin/plugin same-file behavior survives. |
| Delayed A confirmation; UI A→B→A; source generation 1→2→3; logout/relogin with identical values | Invalidated dialog dispatches nothing. A still-valid explicitly bound operation sends only to A. Generation-1 reads, headers and callbacks cannot publish into generation 3. No default-owner fallback. |
| Deferred model page, config queue and post-mutation plugin poll | Same-owner pages share work; identical A/B signatures do not. Every next page/read/write/poll stays with the captured source; invalidation before the next step stops dispatch. A's queue preserves sibling map entries without serializing unrelated B work. |
| B management 401/timeout/malformed 200; C complete empty; late B version/plugin headers | A remains usable; B reports its error and retains labeled stale rows; only C is healthy-empty. No B inventory retirement or global auth/capability contamination. |
| Frozen A/B bulk action, A success and B timeout, C added later | Owner-qualified successes/failures/unknown outcomes, no C request, no success replay, reconciliation tied to B. |
| Discovery and mixed inventory with sentinel secrets and xAI entries | No secret-bearing public output, no automatic adapter/inference/download/queue operation. An explicit authorized action still works against its owner. |
| Source history migration plus A/B collection | No cross-retirement; empty A retires only A; failed A retires none. Old samples/IDs/timestamps survive reopen and repeat migration. Existing source-local Claude results without allowance IDs remain identical. Two same-provider sources produce separate results and unavailable combined arithmetic; a confirmed duplicate never creates new summed capacity. |
| Generated route and plugin fixtures; external single backend | Correct methods, paths, bytes and credential classes; escaped plugin subrequests fail support rather than reach root. Arbitrary external base works as one source without discovery/history service or inferred siblings. |

Existing test seams verified include `tests/managementConnection.test.ts`, `authFilesResponseNormalization.test.ts`, `modelsApiProxy.test.ts`, `configDocumentConcurrency.test.ts`, `pluginTrust.test.ts`, `xaiPaidQuotaFallback.test.ts`, `proxCollector.test.ts`, `proxStore.test.ts` and `proxPoolDomain.test.ts`. These requirements are **not implemented gates** yet.

Preserve hash routing, single-file/external-backend operation, v8 core APIs and declared plugin exceptions. Keep root/`/codex` at GPT/Codex8317, `/claude` at Claude/Claude Code8319, all existing history aliases, and the loopback/LAN listeners in `deploy/nginx.conf`. The manifest must generate those existing destinations, not change inference connectivity or move authenticated accounts.

## NEW RISK

The accepted cost is a visibly unavailable **combined** same-provider quota forecast and potentially unsupported embedded plugin pages, while per-source data and supported actions remain available. The larger implementation risk is a transitive singleton import or lost operation guard; the nested-chain tests and import boundary must catch it before broad UI migration. Generation invalidation also cannot prove whether an already-dispatched mutation completed; reconciliation must remain explicit.

No live allowance scope, deployed plugin compatibility, key-sharing policy, callback reachability or new resource origin was verified. These facts are excluded from the prototype's success claim. They may gate enabling a particular live capability later, not source enumeration or the architecture choice. Use distinct synthetic credentials to test independent auth; do not infer that the two current instances share keys. Source-bound OAuth routing does not solve deployment port conflicts; do not claim otherwise.

**Evidence corrections before synthesis:** Phase 2's generic wording about preserving “ETag/conflict” behavior must not imply that the current frontend patch executor sends `If-Match`: inspected `src/services/api/configPatch.ts:239` does not. Preserve its actual guards; adding optimistic concurrency is a separate behavior change. Candidate Codex/Claude identity metadata described in Phase 2 is not accepted here as an allowance contract. Momus's six reproductions and 46-test run are attributed to its saved report, not re-executed or claimed as this phase's validation. Explorer's runtime observations were not repeated and are not a deployment readiness claim.

Read all four supplied reports and checked the decision-changing paths/symbols against local code. Existing paths cited above were verified; proposed interfaces are explicitly proposals. Repository remains `feat/prox-quota-visual-polish` at `36e2d79b53fef909958a197e6a55f16ab403cee3`. This phase writes only this report. No application edits, application tests/live requests, credential reads, subagents, browser work, commits or deployments were performed. Validation was documentation content/whitespace checking and repository status inspection.
