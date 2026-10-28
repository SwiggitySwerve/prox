# Phase 2 — omo-delphi

**Choose option 4, with option 2's scoped API factories: one deployment-owned manifest generates Nginx routing and public discovery, and supplies the collector's instance inventory. Keep management requests on the existing Nginx transport; keep quota aggregation in its existing server domain. Effort: Large (3d+), approximately 5–10 engineering days including the surface migration and boundary tests; endpoint compatibility is the main uncertainty.**

The manifest enumerates proxy instances, never provider kinds. Aggregate credential and provider inventories in the browser after each source has been normalized separately. Every mutation carries a concrete owner or a frozen, explicitly confirmed list of owners. Do not introduce a general management federation service, move credentials between instances, or treat multiple credential occurrences as independent quota allowances.

This is a research recommendation, not an implementation or verification claim. I read the brief in full, the strategist instructions, repository instructions, and relevant Prox and neighboring CLIProxyAPI source. Repository state was `feat/prox-quota-visual-polish`, `36e2d79`. I did not inspect another seat's output or visual reviews, read credentials, call live services, run tests, change application code, or commit. All existing file paths below were enumerated with `rg --files` in this run. Proposed files are explicitly prefixed `unverified:`.

## 1. Decision and concrete ownership

The four options have materially different costs:

1. **Extend the active switcher:** useful only for explicitly selected destinations. It cannot satisfy aggregate Auth Files or Dashboard visibility. Today `src/features/quotaPool/ManagementRuntime.tsx` switches by calling `login`; `src/stores/useAuthStore.ts` clears the singleton config/model/quota caches. Turning that mechanism into enumeration would create competing sessions.
2. **Browser registry and scoped clients:** good transport and presentation mechanics, but insufficient authority if deployment routes and the collector continue maintaining their own source lists.
3. **Server registry and management relay:** could centralize everything, but would expand the small history service into a credential broker and general HTTP proxy. It would need its own per-instance authorization, multipart/download/header semantics, plugin routing, and external-connection policy. The present `server/app.ts` only authenticates history reads/refresh against one key file. There is no existing general relay to extend.
4. **Deployment manifest plus scoped clients and quota server:** uses the infrastructure already present and removes three competing inventories. This is the lowest-maintenance choice for this deployment, provided the endpoint-routing proof below passes.

### Authoritative source descriptor

Add a narrowly owned source-contract package, proposed `unverified: src/domain/providerSources/`, with its own `unverified: src/domain/providerSources/RULES.md`. It owns descriptor validation, alias resolution, and instance identity only. A proposed `unverified: deploy/provider-sources.json` is its deployment input. A proposed `unverified: scripts/generate-provider-sources.ts` consumes that contract and emits the Nginx routing fragment and sanitized discovery document; these are generated derivatives, not independently edited registries.

Minimum server-side descriptor:

```ts
type DeploymentSource = {
  instanceId: string;          // immutable, opaque; never a provider discriminator
  label: string;
  publicBasePath: string;      // canonical browser prefix for this instance
  aliases: string[];           // root and historical prefixes can resolve to one ID
  upstreamOrigin: string;     // server/deployment only
  managementCredentialRef: string; // reference, never the key value
  browserAuthScope: string;   // explicitly configured credential-sharing boundary
};
```

The deployment document also has a schema version, revision/digest, default instance ID, and a distinct history-service endpoint/auth scope. Do not make history appear to be a third provider instance. Do not put `provider: 'codex'` or `provider: 'claude'` in the source discriminator. Both kinds can appear in one `/credentials` response. Provider adapters determine which returned kinds they support.

Preserve today's root and `/codex` aliases to the existing 8317 instance and `/claude` to the existing 8319 instance. They resolve to two instance IDs, not three inventories. Retain the current loopback/LAN listeners and inference-port split. Subsequent sources get stable IDs independently of labels, ports, or provider kinds. An ID must not be reassigned to a different logical instance; changing its address requires a generation change and continuity validation.

Public discovery contains only revision, default ID, instance IDs, labels, canonical browser bases, aliases, and non-secret auth-scope identifiers. It omits upstream origins and credential-file references. Serve this optional deployment metadata from a fixed same-origin route such as `/prox/sources.json`; fetch it without management credentials. The release remains a single usable HTML file: discovery is an optional feature of this deployment, not a required artifact for arbitrary backend hosting. Missing discovery leaves a normal external connection as one synthetic source. Malformed discovery on a recognized deployment is an error, not permission to invent sibling routes.

Small proposed contracts:

- `validateSourceManifest(input)` → validated deployment descriptor or structured error.
- `publicSources(manifest)` → sanitized discovery response.
- `resolveConnectionSources(connectionBase, discovery)` → one external source or the matching deployment inventory. Match an exact canonical base/alias; same origin alone is insufficient.
- `getSource(instanceId)` → descriptor or explicit unknown-source error. No default-owner fallback.

The generator and collector consume the same validated input. Generated deployment outputs carry the same digest and deployment verification rejects mismatches. Adding an instance changes one input, not a React constant, a collector map, and Nginx by hand. Runtime health, plugin support, and version observations are separate from configured membership: an unreachable configured source remains enumerable as unavailable.

### Browser/server credentials and transport

Extend the implementation in `src/services/api/client.ts`; do not create an unrelated HTTP stack. Its existing `captureConnection()` pins credentials and suppresses effects after a revision change, but `ApiClient` is currently private and its event payloads have no source identity.

Expose a source-scoped construction contract and inject it through the existing API modules:

```ts
captureSource(instanceId): SourceSession
createAuthFilesApi(session): AuthFilesApi
createProvidersApi(session): ProvidersApi
createOAuthApi(session): OAuthApi
// Equivalent factories for the other existing domain APIs.
```

These are proposed contracts. A `SourceSession` contains the instance ID, monotonic session generation, pinned transport, and an `assertCurrent()` operation. Credentials stay encapsulated in transport. Retain the existing singleton exports as compatibility adapters during consolidation, then remove aggregate call sites' dependency on the active singleton. Nested helpers such as `guardConfigConnection`, `getConfigValue`, OAuth map-write queues, `apiCallApi`, and model-discovery in-flight maps must receive that same session. Wrapping only `list()` leaves later reads and writes attached to the wrong backend.

Management credentials remain runtime browser input with the existing remember-password semantics. A key may be reused across declared local sources only under an explicit shared auth scope; proximity, provider type, and a matching URL prefix do not establish shared authorization. Different-key sources have independent authenticated/unavailable states. Do not forward the primary key to arbitrary discovery-provided origins. Restrict deployed discovery to configured same-origin source prefixes; arbitrary external URLs remain explicitly entered single-source connections.

The collector resolves its server-side credential references separately; it does not borrow browser secrets. The history service retains its own authorization boundary. Today one key authorizes its complete pool: keep that explicit deployment-wide access policy. If per-source user entitlements become a requirement, that is a separate authorization change, not an implication of adding source descriptors.

Version/plugin/401 effects carry `{ instanceId, generation }`. A secondary source's 401 marks that source unauthorized and cannot emit the unqualified event that logs out the primary session. Keep existing primary/external logout behavior. Logout or actual connection/key replacement invalidates affected generations; a view filter does not reconfigure transports. Destructive confirmations, drafts, and OAuth attempts additionally carry their owning selection/attempt generation so A→B→A cannot revive stale work.

Nginx continues forwarding the browser's management bearer, without inserting a privileged server key. `/v1/models` uses that source's client API key, not its management key. Plugin resource navigation remains without an injected management bearer, matching the backend's resource contract. Never put keys in iframe URLs or the discovery document.

### Resource identity and aggregation

Use an outer `instanceId` envelope; do not overload existing `source`, `ProviderSource`, or plugin-store `sourceId` fields. Those already mean other things.

- Credential card/cache identity: tuple `[instanceId, existingLocalQuotaIdentity]`. Preserve the current filename-versus-Devin/plugin multi-identity behavior inside each source. `normalizeAuthFilesResponse` in `src/services/api/authFiles.ts` must run on each response **before** concatenation; it currently groups by `getQuotaCacheKey` from `src/utils/quota/identity.ts`.
- Physical file operations: `[instanceId, filename]`, with an optional source-local auth index only for endpoints that support it. Several runtime identities can share one physical file; delete/download must not pretend otherwise. Do not parse a composite UI key back into a filename.
- Runtime auth selection: `[instanceId, authIndex]`; provider-resource selectors retain their existing config group/key selector inside the instance envelope. Sensitive selector values stay out of route strings and rendered IDs.
- Model: `[instanceId, modelId]`; a grouped display may list all owners of one model label, but must not discard owner-specific availability.
- Plugin: `[instanceId, pluginId]`; store operations additionally retain the existing registry `sourceId` and store identity.
- Log request/error file: `[instanceId, localRequestId/localFilename]`. Cursors are opaque values scoped to the exact source session.

Cache and request-deduplication keys include source session generation, resource identity, and relevant arguments. Keep the full-config TTL/deduplication contract in `src/stores/useConfigStore.ts`, partitioned by source session; do not replace it with independently fetched sections. Partition quota generations, model credentials, refresh pending sets, UI selection, and invalidation events the same way. `models.ts` currently has Claude/Gemini in-flight signatures without source identity; these need particular attention.

Each aggregate read returns per-source status, items, last-success time, and completeness. Transport failure, malformed payload, incomplete pagination, unauthorized, and valid empty inventory are distinct. Successful sources remain visible during an outage. Stale last-success rows may remain labeled stale, but cannot make an aggregate look complete. Do not turn `catch` into an empty successful source. The source registry owns no sums or forecasts: Auth Files owns inventory composition, Providers owns resource composition, Dashboard owns traffic summaries, and the quota domain owns allowance arithmetic.

Dashboard traffic is **observed per-instance traffic**, not inferred unique end-to-end requests. Existing deduplication between API-key usage and credential usage runs within each source before aggregation. Source namespacing neither proves unique upstream accounts nor proves that two proxy layers observed different requests.

## 2. Route/action matrix

`M(S)` below means the chosen source's existing `/v8/management` base; it is not a new endpoint scheme. Source context must survive navigation, reload, and editor links, for example through a validated `instance` query parameter. Exact-resource links carry their source; missing source on an ambiguous editor requires a selection, never a guessed owner.

| Surface / current UI route | Read scope and endpoint families | Action destination and state boundary |
| --- | --- | --- |
| Dashboard `/dashboard` | Aggregate per-source config summaries, `M(S)/credentials`, `M(S)/observability/usage/api-keys`, and source catalogs. Report completeness and credential occurrences. | Refresh the chosen read scope; drilldowns carry the source. No destructive aggregate action and no usage-queue consumption. Extract existing arithmetic from `useDashboardOverview.ts` into its feature-owned pure domain functions before changing the aggregate. |
| Providers `/ai-providers`, `/quick-start` | Aggregate source-owned resources obtained through config and existing provider adapters; filtering by provider must still show instances of the same kind. | Create/import requires an explicitly selected source. Edit/delete/disable/model discovery/connectivity tests use the row's source and existing selector. Preserve sponsor mutation-recovery behavior within that source. Provider form capabilities stay in `src/features/providers/descriptors.ts`. |
| Auth Files `/auth-files` | Aggregate separately normalized `M(S)/credentials`; source badge and per-source error state. Model detail uses owner `M(S)/credentials/models`. | Upload has one selected destination. Download/delete are physical-file owned; status, fields, refresh, cooldown reset retain each endpoint's local lookup semantics. All queued selections and confirmations contain source-qualified targets. |
| Auth-file OAuth editors `/auth-files/oauth-excluded`, `/auth-files/oauth-model-alias` | One explicit source's OAuth config maps under `M(S)/config/...`; there is no merged editable config document. | Draft, map-write serialization, preview/guard, and save remain on that source. Link from an aggregate view must carry it. |
| OAuth `/oauth`, including Vertex import and SIWC | Provider choices can enumerate capabilities by source, but an attempt is `[instanceId, provider, attemptId]`. | Start, status polling, callback submission, cancel, SIWC bind/status, and import all use the captured source. Plugin OAuth follows its declared URL with the same owner. Selection changes cannot retarget an in-flight flow or cancellation. Preserve provider callback payloads and existing cancellation semantics. |
| Detailed quota `/quota/accounts` and quota inside Auth Files | Aggregate source-owned credential cards. Each quota request uses its own `M(S)/requests/api-call` or existing provider/plugin quota API. | Refresh targets explicit cards or a frozen read scope. Codex reset-credit redemption, Claude grant actions, plugin reset, and subsequent cooldown reset are explicit mutations pinned to the credential owner; never fan out by provider kind. |
| Pooled quota `/quota` | One history-service read through the advertised history endpoint, retaining the existing `/prox/pools` management path aliases for compatibility. Collector enumerates instances once, then dispatches supported provider kinds. Do not query the same history service once per source. | `/prox/refresh` remains explicitly a deployment-wide observation refresh with server single-flight/rate limiting. It does not mean refresh credentials, consume queues, or redeem limits. Additional source filters would require server-owned semantics; do not silently add them. |
| Logs `/logs` | One explicitly selected source for application stream, error logs, and request log lookup through `M(S)/observability/logs...`. A source selector satisfies this resource's scope; merged cursor streams are unnecessary. | Clear, error-file download, and request-ID download use the selected source snapshot. Selection invalidates pending confirmations and resets the buffer/cursor; no shared cursor and no cross-source `clear all`. |
| Config `/config`, `/settings`, `/api-keys` redirects | One source's full config/YAML, with the existing TTL, ETag/conflict, and diff behavior. | Draft, preview plan, saves, retry/rebase, and cache updates carry the same source/session generation. Switching away prompts/retains/discards using existing unsaved-change UX; it never replays a draft onto another source. |
| Plugins `/plugins` | Aggregate installed inventories if supported per source, retaining every `[instanceId, pluginId]`. Route visibility depends on supported sources, not just the primary backend's header. | Enable/delete/configure use the owning source. Unsupported or failed sources remain distinguishable. |
| Plugin store `/plugin-store` | One selected destination's registry listing; catalogs can differ because of backend config/auth. | Install carries both proxy `instanceId` and registry `sourceId`, plus the existing trust confirmation and version. Do not reinterpret registry identity as deployment identity. |
| Plugin pages `/plugin-pages/:pluginId/:menuIndex` and menus/logos | Read the selected plugin's owner inventory, then its backend-declared resource path. Include instance context in menu keys and links. | Preserve resource paths and no-auth navigation. Prefix rewriting must not send nested resource requests to root/8317 accidentally. Third-party absolute URLs retain existing trust semantics; never attach source credentials. |
| Catalogs, model discovery, System `/system` | Catalog overview can group models with owner sets. System version/config diagnostics are source selected. Catalog request is source `/v1/models` with its client API key; static definitions remain `M(S)/routing/model-definitions/:channel`. Upstream discovery remains via the selected source's API-call transport. | Form model selection uses the form's destination catalog. No pooled model identity silently resolves to the primary source. System actions/version checks use an explicit destination. |

**“All” must be a typed scope, not an unqualified boolean passed across sources.** For aggregate delete/status/download/credential-refresh, confirmation freezes source-qualified target references from a complete applicable inventory and shows counts by source. Partition that fixed list into existing source-local batch calls; return confirmed successes, failures, and outcome-unknown targets with owner identity. Keep failed/unknown targets available for retry or reconciliation; do not retry successful destructive work automatically. Failures cannot expand the target list or switch owners. Disable an “all configured sources” destructive action if any required inventory is incomplete; users can explicitly choose the successful subset. Preserve true backend `all:true` only in an explicitly selected-source operation whose wording says all backend credentials, including unseen ones. A filtered selection must never become backend `all:true`.

## 3. Endpoint and quota identity evidence that changes the plan

### Source-local routes need more than management prefixes

`deploy/nginx.conf` only forwards ordinary management paths to 8317/8319 and the three pooled-history aliases to 18319. Other paths fall through to static-file handling. Therefore successful management login proves neither source catalogs nor plugin resources work.

Primary backend evidence:

- `/home/swerve/src/CLIProxyAPI/internal/api/server_management_v8.go` registers the v8 config, credentials, OAuth, logs, plugin-management, and API-call routes used here. No new v0 management fallback is warranted.
- `/home/swerve/src/CLIProxyAPI/internal/api/server_routes.go` puts `/v1/models` behind `AuthMiddleware(s.accessManager)`. Prox `src/services/api/models.ts` already uses a client API key for this route. Generate source-local catalog routes with the correct credential type; do not proxy the entire inference API merely to expose the catalog.
- `/home/swerve/src/CLIProxyAPI/internal/pluginhost/management.go` still declares plugin extension base `/v0/management` and resource base `/v0/resource/plugins`; `ServeResourceHTTP` is intentionally browser-navigable without management authentication. `/home/swerve/src/CLIProxyAPI/internal/api/server_management.go` dispatches these separately. These are the repository's explicit plugin-path exception, not permission to revive legacy core APIs.
- `src/features/plugins/pluginResources.ts:resolvePluginAssetURL` currently prepends the connection base to root-relative paths; `PluginResourcePage.tsx` renders an iframe without a bearer. Generated routing must preserve source ownership for these paths. A document containing its own root-relative fetches or redirects can escape a path prefix. I have not established that every deployed plugin is prefix-compatible; do not claim it from the iframe's initial URL.

The first transport proof must cover catalog JSON, multipart upload, blob download, ETags, OAuth callback query/body preservation, plugin HTML plus relative/root-relative subrequests, and original-path custom extensions. No regex rewrite of returned HTML is recommended. If an actual plugin requires an origin root, provide an explicit source-specific resource origin through the same manifest and prove LAN/reachability behavior, or leave that resource visibly unsupported pending a concrete deployment decision. Never route an ambiguous root-relative request to the default source. That escalation changes the cost estimate and is a reason to stop broad migration early.

### Credential occurrence is not a quota allowance

`server/quota/collector.ts:inventory` hashes provider plus auth index. `server/quota/store.ts:recordInventory` retires every prior account of that provider. `server/quota/domain.ts` assigns `eligible.length * 100` capacity points. Adding source IDs fixes collisions and retirement but does not establish independent allowance capacity.

The backend's `/home/swerve/src/CLIProxyAPI/sdk/cliproxy/auth/types.go:indexSeed` can derive auth index from provider plus a local file path. Copying one upstream account to two different paths can produce different auth indices; identical filesystem paths on different instances can collide. Neither equality nor inequality of this index is an upstream allowance contract.

There are two distinct identities:

1. **Credential occurrence:** `(instanceId, provider, authIndex)` for observation transport/history ownership, with filename separately for physical file actions.
2. **Allowance identity:** provider-specific account/tenant/budget scope, with explicit evidence and window family. Used only in quota-domain arithmetic. It must not control credential mutations or hide credential rows.

Useful metadata and its limits:

- Codex `extractCodexIDTokenClaims` in `/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/auth_files.go` exposes a sanitized `id_token.chatgpt_account_id` object. `resolveCodexChatgptAccountId` in `src/utils/quota/resolvers.ts` already reads that representation. Detailed quota's `buildCodexRequestHeader` in `src/features/quota/providers/codex/data.ts` adds `Chatgpt-Account-Id`; the collector discards this metadata and sends only `CODEX_REQUEST_HEADERS`. Consolidate the request-header rule first, then fix the collector in a separate behavior change with a payload test. An account identifier is evidence for repeated-account detection, not universal proof that every plan/window has an independent budget or that account scope equals user scope.
- Claude token storage defines `account_uuid` and `organization_uuid` in `/home/swerve/src/CLIProxyAPI/internal/auth/claude/token.go`; `buildAuthFileEntryLocked` does not expose those fields. Prox's existing detailed quota flow fetches `CLAUDE_PROFILE_URL`, and `src/types/quota.ts:ClaudeProfileResponse` declares `account.uuid` and `organization.uuid`. These offer a bounded, source-owned read path for obtaining candidate scope metadata during later implementation. Their presence on the deployed services and precise allowance meaning were not verified live. Do not download credential files to fill this gap or quietly add backend edits to this Prox task.
- Email, filename, plan name, raw token equality, and the generic `account` field are unsuitable fallback identities. `account` can contain an API key. Never log or serialize identity metadata wholesale. Persist only minimal, versioned opaque identity evidence privately if needed; hashing sensitive metadata does not make it public data.

**Initial safe quota policy:** preserve all credential observations and their history. Group only allowances whose provider-specific scope is established; do not sum repeated proven allowance observations. Missing or ambiguous scope makes the provider's claimed unique capacity and forecast unavailable, with credential counts and per-credential measurements still visible. If old normalized-point statistics are retained for continuity, label them explicitly as credential-occurrence statistics with unverified independence; they must not masquerade as unique available capacity or a ready forecast. Update the server-owned rules and API types to represent this state rather than inventing a number.

For a proven repeated allowance, retain all occurrences but select one observation stream for arithmetic with a documented deterministic preference. Prefer fresh successful observations, detect materially conflicting simultaneous observations, and mark conflict unknown instead of choosing an optimistic value. A representative change must not manufacture a depletion interval across two unrelated observation streams. Never deduplicate UI credential rows or file mutations just because allowance identity matches. This rule belongs in `server/quota/domain.ts` and `server/quota/RULES.md`, not in the source registry or rendering code.

## 4. Implementation sequence and exact boundary tests

1. **Run the bounded compatibility proof before broad migration.** Use two synthetic backends and a temporary generated Nginx configuration, no real keys/accounts. Prove Auth Files enumeration plus owner-targeted mutation, and the endpoint cases above. Include a mixed-provider source and two sources returning the same provider, filename, and auth index. Obtain a reviewed quota metadata contract using synthetic Codex/Claude examples; unknown scope must be a supported result. Do not consume live refresh/usage queues or inference to test the design.

2. **Behavior-preserving consolidation commit.** Extract the source descriptor owner, generator, and API construction seams while the UI still uses one existing connection. Convert default deployment routes/origins to the manifest with the same ports, aliases, key references, auth behavior, and selected-source output. Refactor existing API implementations rather than copy them. Parameterize their nested helper dependencies and queues. Extract Dashboard summary calculations from the hook into a feature-owned pure module before adding cross-source arithmetic. Extract the existing Codex header construction rule without yet changing collector behavior. Compare deterministic existing inventory/dashboard/quota output dumps before and after; preserve guards, clamps, rounding, and null semantics. No multi-source UI, ID rewrite, or capacity correction belongs in this commit.

3. **Separate routing and source-session fix.** Publish optional discovery; add the verified catalog/plugin routes; implement source-local event state, generations, cache partitions, and scoped source APIs. Keep the external single-backend compatibility path. Test factory behavior before migrating screens. Do not retain a generic `setActiveSource` around asynchronous calls as a substitute for actual scoped clients.

4. **Visible inventory/write fix.** Migrate Auth Files first so Claude appears alongside Codex without a global login switch; migrate Providers and Dashboard next. Carry source provenance through cards, counts, filter/selection, detail links, model dialogs, pending operations, and invalidation events. Give upload/create a concrete destination. Implement the frozen-scope bulk contract. Then migrate explicitly selected Config, Logs, OAuth/editor flows, Plugins/store/resources, System/catalogs, and detailed quota using the matrix. Preserve visual components and unrelated polish; no layout redesign is needed.

5. **Separate history/schema and collector fix.** Migrate history under the policy below. Fetch each instance's complete inventory once and split supported provider kinds within the collector. Unsupported kinds remain visible in general inventories without pretending pooled quota supports them. Change the store boundary to `recordInventory(instanceId, provider, completeInventory, observedAt)` so retirement affects only that pair. Only a validated complete successful response authorizes retirement, including a truly empty provider list. Failed/paginated/malformed inventories leave last known membership intact and emit source-qualified issues. Do not silently swallow persistence failures. Add Codex account-aware request headers as its own independently tested behavior change.

6. **Separate allowance arithmetic fix.** Implement evidence-backed allowance grouping or explicit unknown independence; extend `src/domain/quotaPool/types.ts` and `server/quota/RULES.md`. Keep existing `src/domain/quotaWindows/claude.ts` and `codex.ts` as window conversion owners. Do not reimplement parser math in collector, frontend, or manifest. Keep all samples and history gaps; verify representative/unknown/conflict behavior with synthetic observations.

7. **Run the repository checks and later UI acceptance.** Focused Bun tests per change, then `bun run verify`; browser checks of every changed route and screenshots happen only in the later authorized implementation phase. Existing static markup tests do not prove browser interactions. Check generated routing/discovery against the manifest and smoke-test LAN access without modifying the proxy inference listeners. Review all remaining singleton imports and explain any intentionally selected-source adapters.

Required assertions, placed in the existing named suites or focused adjacent suites:

| Boundary | Exact regression assertions |
| --- | --- |
| Manifest/generator | Duplicate IDs/aliases and unknown default ID reject; root and `/codex` produce one inventory; source rename does not change ID; public discovery contains no upstream origin/key reference/key; routing/discovery/collector share revision; changing one manifest entry changes all derived consumers. |
| Transport/session | Extend `tests/managementClientV8.test.ts`, `tests/proxRuntime.test.ts`, `tests/managementConnection.test.ts`: A and B requests overlap and each retains base/auth; B 401 leaves A authenticated; B plugin/version headers cannot overwrite A; A→B→A makes old confirmations/drafts stale; key rotation/logout prevents old result publication. No source failure retries a mutation on another source. |
| External compatibility | Arbitrary external origin and prefixed base keep existing v8 URLs, client-key catalog behavior, primary 401/logout semantics, plugin-declared paths, and single-file operation without discovery/history server. No inferred `/claude` or `/codex` siblings. Recognized deployment discovery failure remains visible rather than silently shrinking scope. |
| Inventory identity | Extend `tests/authFilesResponseNormalization.test.ts`, `tests/devinQuotaIdentity.test.ts`, `tests/quotaSessionIsolation.test.ts`: A/B same filename+authIndex remain two occurrences; one mixed-provider inventory yields both kinds; same-file Devin/plugin identities retain existing normalization; caches/selections/invalidation for A do not touch B. Invalid/partial payload differs from valid empty. |
| Owner writes and bulk | Extend auth-file action suites: confirmed A-delete cannot delete B's same filename after selection changes; multi-identity physical deletion has one file target; partial batch success removes only confirmed successful targets; timeout yields unknown/reconciliation state; retry cannot repeat confirmed successes or widen scope. Incomplete-source inventory blocks destructive “all configured sources.” |
| Config/providers | Extend `tests/configDocumentConcurrency.test.ts`, `tests/configDocumentSemantics.test.ts`, `tests/configStoreV8.test.ts`, `tests/providerEditingV8.test.ts`: source-specific full-config dedup/TTL; same group/index on A and B stays separate; preview from A cannot save B or a later A generation; concurrent OAuth-map/config writes serialize per owning source; ETag conflicts preserve existing behavior. |
| OAuth | Extend `tests/oauthAttempts.test.ts`, `tests/oauthRequestCancellation.test.ts`, `tests/siwcBinding.test.ts`: start on A, switch selection to B, late status/callback/cancel remains bound to A or safely invalidated; no cleanup through B; logout prevents stale state; identical provider attempts on separate sources do not replace one another. |
| Logs | Extend `tests/logRequests.test.ts`, `tests/logsApi.test.ts`: A cursor is never sent to B; source change resets local buffer; stale A clear confirmation cannot clear B; same request/error filename downloads from its source; late result cannot repopulate the new source buffer. |
| Catalog/plugins | Extend `tests/modelsApiProxy.test.ts`, `tests/modelsStore.test.ts`, `tests/pluginTrust.test.ts`, `tests/managementConnection.test.ts`: overlapping model IDs retain both owners; client keys stay separate from management keys; duplicate plugin IDs have distinct menu links; install carries proxy instance and unchanged registry source; secondary plugin support enables its surface without rewriting primary capability. Exercise nested plugin resource paths, not just initial URL generation. |
| Collector/store | Extend `tests/proxCollector.test.ts`, `tests/proxStore.test.ts`: A/B of one provider cannot retire each other; one mixed source is inventoried once; A outage/401/partial page preserves A membership while B succeeds; valid empty A retires only A; source-local authIndex reaches correct origin; Codex account header uses captured inventory metadata; no usage queue/inference/credential mutation calls. |
| Allowances/history | Extend `tests/proxPoolDomain.test.ts`, `tests/proxHttp.test.ts`: repeated proven allowance across sources contributes once; different source IDs without scope evidence do not create independent capacity; email equality never merges; missing identity/conflicting observations prevent ready forecasts; representative switch creates no artificial burn; source outage is visible; default responses omit identity metadata. Migration assertions below preserve all historical tuples. |

### History migration policy

Do **not** truncate history, recreate the database, or change every old account ID and accept a gap.

The old store contains provider, opaque ID, name/email, and samples, but no source provenance or raw auth index. It cannot reconstruct a trustworthy original instance by matching email or filename. Use a versioned, transactional, additive migration with an explicit legacy-provider-to-instance mapping from the known prior deployment configuration. For this deployment the reviewed defaults map Codex collection to 8317 and Claude collection to 8319; do not assume that mapping for an arbitrary database previously configured with custom origins.

Keep existing account primary keys and sample foreign keys. Add source attribution and, if needed, a small occurrence-identity lookup through public store methods. At ingestion, recompute the old provider/authIndex hash only for the explicitly mapped legacy source and reuse its existing account ID. New occurrences receive versioned source-qualified IDs. A same-provider second source must never adopt a legacy row merely because its local auth index matches. Unknown provenance stays retained as legacy/unassigned history, excluded from attributed current pool totals until resolved. Labels, endpoint aliases, or display-name changes cannot rewrite history identity.

Keep allowance grouping separate from occurrence IDs and raw samples. Do not rewrite two old sample series into a fabricated single historical series when duplicate allowance evidence appears. Apply explicit grouping rules to projections and retain provenance/evidence validity; uncertain earlier identity remains uncertain. Renamed/moved credentials whose backend auth index changed start a new occurrence unless continuity is proven; do not bridge by email.

Before production migration in the implementation phase, stop collection and create a consistent SQLite backup with permissions preserved, then migrate in a transaction. Test using a fixture database in the old schema: every `(accountId, window, observedAtMs, remainingPercent, resetAtMs, periodHours)` tuple and `firstSampleAtMs()` stays unchanged; account retirement/error state remains; foreign-key check passes; reopening/re-running migration is idempotent; an interrupted migration rolls back; new source collisions cannot steal old history. Retention remains the existing 30-day rule, not a migration purge. Rollback uses the old binary with its preserved pre-migration backup, rather than assuming old code safely reads new schema/semantics.

## 5. The expensive failure and cheapest falsification

**The most expensive failure is a convincing aggregate UI whose writes or observations still use the mutable singleton underneath.** That can delete or modify the wrong same-named credential while silently attributing its history to another source. A second, less visible failure is a numerically plausible quota forecast that doubles one upstream allowance. Both can survive a happy-path two-provider demo.

The cheapest empirical gate is a small synthetic vertical slice before migrating the other pages: two same-provider sources, colliding filenames/auth indices, one mixed-provider response, independent fake management/client keys, and a disposable old-schema history fixture. Enumerate both through generated routes, execute one captured-owner mutation after an A→B→A selection change, fail B's inventory with 401, and show that A's session and history remain intact. Return a repeated allowance identity from both sources and prove it does not double capacity; remove the metadata and prove the result becomes explicitly unknown. In the same fixture transport, exercise catalog authentication and one plugin document with nested root-relative requests.

This should fit approximately half a day to one day using existing Bun tests and synthetic services. A pass establishes the transport/ownership mechanics, not live provider allowance semantics. The costliest unresolved fact remains whether the deployed plugin surfaces work behind prefixes and whether available quota metadata actually identifies the allowance scope. If either fails, narrow the relevant surface explicitly before undertaking a full migration; do not hide the gap in a generic federation abstraction.

**Exact objections to reject during synthesis:**

- “One global source selector solves visibility.” It cannot produce the required aggregate inventories and still logs into a different singleton connection.
- “Just add a source field.” Insufficient without source-bound API factories, nested helper injection, caches, mutation confirmations, and source-qualified retirement.
- “All v8 endpoints work, so every page works.” Catalogs use a separate client-auth path; declared plugin resources/extensions are separate paths and may have nested routing assumptions.
- “Same provider + different source equals more capacity.” No; source identity records transport ownership only.
- “Use email/account/auth index to deduplicate quota.” Email is not scope, generic account may be secret, and auth index may be file-path-derived. Available Codex/Claude metadata needs an explicit quota-domain rule and unknown state.
- “Regenerate account IDs; history will refill.” It destroys continuity and can disguise double counting. Preserve sample tuples and migrate provenance explicitly.
- “The server can safely reuse its key for any browser-selected destination.” That adds an unimplemented credential/authorization boundary. Keep destinations manifest-owned, browser keys scoped, and history authorization explicit.

The recommendation stands if these boundaries remain concrete. It does not depend on generic resource federation, automatic instance discovery, provider-specific deployment schemas, or a new management proxy service.
