# Phase 2 — Momus executability review

**Decisive objection: enumeration does not establish ownership.** The existing application and quota store identify resources inside one connection/provider namespace. Feeding multiple instances into those contracts can merge credentials, send a confirmed mutation to the current connection instead of its owner, retire another instance's accounts, and count one allowance twice. These are reproduced failures or direct consequences of verified call sites, not objections to the size of the work.

Option 1 fails the requested combined visibility. Options 2–4 remain executable directions, but none is ready for approval if “scoped clients” leaves the contracts below unchanged. I found no inherent executability reason to reject a server relay or a generated-routing hybrid after these conditions are incorporated.

## Evidence boundary

Read the complete shared brief, repository instructions, personal working guidance, Momus role and Council skill. This is Phase 2 decision review, not an OpenSpec change review; no change-specific `openspec validate` was applicable. Did not read other seats, visual reports, parent threads, credentials, live inventories or database contents. No browser, network requests, production operations, app edits or commits were performed. Only this report was written.

All source/test paths cited below were verified using `rg --files` in this run. References describe the working-tree code inspected, not a claim about deployed runtime behavior. Synthetic probes used in-memory SQLite, pure functions and an Axios adapter; no actual proxy was called.

## 1. What blocks each option

| Option | Verdict and prerequisite |
|---|---|
| **1. Extend the global switcher** | **Killed as the complete solution.** [runtimeConnection.ts](/home/swerve/src/prox/src/features/quotaPool/runtimeConnection.ts:5) recognizes root, `/codex`, `/claude` and equates route with provider; [ManagementRuntime.tsx](/home/swerve/src/prox/src/features/quotaPool/ManagementRuntime.tsx:16) performs a global login. [MainLayout.tsx](/home/swerve/src/prox/src/components/layout/MainLayout.tsx:1216) mounts it only for detailed quotas and logs. Showing it everywhere still returns one inventory at a time and cannot represent two Codex instances or a mixed-provider instance. It is useful as an explicit-source control after a registry exists. |
| **2. Registry + browser enumeration** | **Viable with changes; browser-only authority is incomplete.** Domain APIs close over the singleton, config has one unkeyed cache/in-flight promise, and the collector has its own provider-to-origin map. See [authFiles.ts](/home/swerve/src/prox/src/services/api/authFiles.ts:545), [useConfigStore.ts](/home/swerve/src/prox/src/stores/useConfigStore.ts:27), [collector.ts](/home/swerve/src/prox/server/quota/collector.ts:24). Introduce a source-bound transport/session contract and migrate consumers; the collector and deployment must consume the authoritative inventory too. A persisted browser registry by itself does not supply the unattended server collector. Existing routes also need catalog/plugin coverage. |
| **3. Server registry + relay** | **Viable, but the existing history service is not that relay.** [app.ts](/home/swerve/src/prox/server/app.ts:47) authenticates one key and serves pools/refresh; other paths return 404. The new boundary must resolve an authorized instance explicitly, preserve v8 methods/query/body/status/headers and downloads/uploads, and distinguish relay authentication failure from an upstream's 401. A management-only relay does not cover catalog or plugin resources. Keep a direct single-backend adapter: the repository's single-file deployment and arbitrary external connection contract cannot require this new server universally. Frontend ownership still matters even when transport is server-owned. |
| **4. Manifest + generated routes/discovery + scoped clients** | **Viable, provided “existing quota aggregation” means preserving its domain owner, not its identity/store contract unchanged.** [nginx.conf](/home/swerve/src/prox/deploy/nginx.conf:30), [runtimeConnection.ts](/home/swerve/src/prox/src/features/quotaPool/runtimeConnection.ts:5), and [collector.ts](/home/swerve/src/prox/server/quota/collector.ts:36) currently encode the deployment independently. One manifest must generate/serve compatible browser discovery, routing and collector input. It must include the needed non-management route classes, stable instance IDs and configuration generations. Quota retirement, migration and allowance membership still require the changes below. |

**Smallest option-level acceptance probe:** use a synthetic manifest containing A and B with Codex, and C with both Claude and Codex. Add/remove B once. Discovery, generated route targets and collector inputs must agree without editing independent provider/origin lists. Combined Auth Files must show all occurrences. An unrelated external backend must remain a one-source connection with no inferred sibling routes. The generated deployment must preserve the existing LAN listener and 8317/8319 destinations.

## 2. Falsification cases and acceptance conditions

### A. Colliding filenames/auth indexes and delayed mutations

**Verified:** [authFiles.ts:314](/home/swerve/src/prox/src/services/api/authFiles.ts:314) groups rows through [getQuotaCacheKey](/home/swerve/src/prox/src/utils/quota/identity.ts:11), normally the filename. [useAuthFilesData.ts:98](/home/swerve/src/prox/src/features/authFiles/hooks/useAuthFilesData.ts:98) stores selection as names; its delete confirmation calls the singleton at confirmation time ([line 322](/home/swerve/src/prox/src/features/authFiles/hooks/useAuthFilesData.ts:322)). Cache invalidation also interprets names globally ([useQuotaStore.ts:116](/home/swerve/src/prox/src/stores/useQuotaStore.ts:116)). Adding an unused source property cannot fix these contracts.

The backend independently resolves deletes in its own auth directory ([auth_files_crud.go:142](/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/auth_files_crud.go:142)) and `authIndex` through its own manager ([api_tools.go:819](/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/api_tools.go:819)). A provider name cannot select the instance.

**Executed probe:** pass two synthetic Codex entries with identical filename/index and distinct `proxyInstanceId` values to the existing normalizer. **Two rows become one.** This establishes the failure of merging raw inventories before source-aware normalization; it does not allege that today's one-source UI already merges two proxies.

**Smallest settling test:** normalize A and B independently, combine their results, select/delete/disable/refresh/download only A's occurrence with mocked APIs. Open A's confirmation, switch to B, then confirm. Include the existing Devin/plugin multi-identity case within A.

**Accept:** both source occurrences survive; same-source multi-identity behavior is preserved; backend filenames/indexes remain unchanged; every request goes only to the captured owner, or an invalidated confirmation is refused. A missing owner never falls back to B. Cache deletion for A leaves B untouched. Use a structured instance/resource reference rather than encoding a source into a filename sent upstream.

### B. Partial inventory, 401 and global response contamination

**Verified:** [client.ts:150](/home/swerve/src/prox/src/services/api/client.ts:150) emits version/plugin events without a source identifier; [line 187](/home/swerve/src/prox/src/services/api/client.ts:187) emits global `unauthorized`; [useAuthStore.ts:245](/home/swerve/src/prox/src/stores/useAuthStore.ts:245) logs out on it. `captureConnection()` pins a connection and suppresses events after its parent revision changes, but does not itself define per-source event ownership. The ordinary singleton has no request-revision predicate on response events.

**Executed probes:** a mocked A response released after configuring B emitted `server-version-update` with A's version. A current captured client's mocked 401 emitted global `unauthorized`. Also, `normalizeAuthFilesResponse({error: 'synthetic upstream error'})` returned `files: []`: a successful but malformed relay envelope can masquerade as empty inventory unless validated before this normalizer.

Existing collector behavior is better: [collector.ts:341](/home/swerve/src/prox/server/quota/collector.ts:341) records an inventory issue and skips `recordInventory` when fetching/validation fails. Preserve this distinction; do not convert its failure branch into a successful empty source.

**Smallest settling test:** A succeeds, B returns 401/timeout/malformed 200, C returns a valid complete empty inventory; then release stale version/plugin headers from B.

**Accept:** A remains usable and authenticated; B has a source-local error/unknown completeness and retains identifiable stale data where supported; only C is healthy-empty. B's failure never retires its history, changes A's capabilities/version or turns the combined inventory into “complete.” An actual application-session authentication failure may still invalidate that session. Aggregate result envelopes must retain per-source failures rather than flattening them into `[]`.

### C. Changed source configuration, ABA and cache ownership

**Verified protections to retain:** [client.ts:39](/home/swerve/src/prox/src/services/api/client.ts:39) increments revision on base/key changes; [useAuthFilesData.ts:208](/home/swerve/src/prox/src/features/authFiles/hooks/useAuthFilesData.ts:208) guards list completion; [useConfigDocument.ts:121](/home/swerve/src/prox/src/features/config/hooks/useConfigDocument.ts:121) binds operations/preview saves to a revision; [providers.ts:247](/home/swerve/src/prox/src/services/api/providers.ts:247) guards config reads; [useLogStream.ts:216](/home/swerve/src/prox/src/features/logs/hooks/useLogStream.ts:216) invalidates synchronously on auth transitions. These are not missing mechanisms to reinvent.

Their scope is the global connection. A registry can change A's endpoint/key while the selected connection remains unchanged. A stable `instanceId` alone then incorrectly admits old results. Conversely, [useConfigStore.ts:27](/home/swerve/src/prox/src/stores/useConfigStore.ts:27) cannot concurrently cache two sources. [useDashboardOverview.ts:132](/home/swerve/src/prox/src/features/dashboard/hooks/useDashboardOverview.ts:132) currently commits its auth-file read without the list hook's revision guard.

**Smallest settling test:** defer a read and config preview for A generation 1; replace A's configuration, then restore its original values as generation 3; release generation 1. Repeat with logout/reconnect using identical connection values and with a pending bulk confirmation.

**Accept:** obsolete reads, headers, confirmations and saves cannot affect the new session. Cache and in-flight keys include instance identity plus a non-reused configuration/session generation. Config drafts stay with their original source or require an explicit reload/rebase. Logs never reuse A's cursor for B. No read/modify/write operation changes owner between steps.

### D. “All” and partial bulk failure

**Verified:** [useAuthFilesData.ts:348](/home/swerve/src/prox/src/features/authFiles/hooks/useAuthFilesData.ts:348) maps unfiltered delete-all to one backend's `all=true`, then removes all non-runtime rows locally. [batchDelete](/home/swerve/src/prox/src/features/authFiles/hooks/useAuthFilesData.ts:904) deduplicates names; result failures are named without an instance ([authFiles.ts:53](/home/swerve/src/prox/src/services/api/authFiles.ts:53)). There is useful existing partial-result support for one source, but it cannot identify two failures/successes sharing one name across sources.

**Smallest settling test:** freeze a selection containing `A/shared.json` and `B/shared.json`; A succeeds and B returns per-file failure, then repeat with B timing out after dispatch. Add C after confirmation.

**Accept:** dispatch groups by captured owner; counts and rows distinguish both occurrences; C is untouched; successes are removed/updated once and failed items remain visible/retryable. Timeout after dispatch is reported as an unknown outcome requiring reconciliation, not a proved failure or full success. Define whether “all” means a displayed snapshot or an explicitly named server-wide scope; do not silently expand it to newly discovered sources.

### E. OAuth state belongs to the initiating backend

**Verified:** [oauth.ts:49](/home/swerve/src/prox/src/services/api/oauth.ts:49) sends start/status/cancel/callback through the singleton. [useOAuthFlows.ts:98](/home/swerve/src/prox/src/features/oauth/hooks/useOAuthFlows.ts:98) already invalidates attempts synchronously on global connection changes, so it would be incorrect to claim it universally continues polling B after switching from A. The missing contract is keeping an attempt bound to an instance in a concurrently enumerable registry. [captureSiwcBindingApi](/home/swerve/src/prox/src/services/api/oauth.ts:87) is an existing pinning precedent.

Backend callback validation reads the local pending session and rejects unknown state ([oauth_callback.go:90](/home/swerve/src/CLIProxyAPI/internal/api/handlers/management/oauth_callback.go:90)). A callback routed by provider instead of initiating instance is therefore insufficient, even if both instances support that provider.

**Smallest settling test:** two synthetic backends expose the same OAuth provider. Start on A; change selected source and replace A's registry generation while start/status/callback/cancel are deferred. Test plugin OAuth and SIWC cleanup too.

**Accept:** each request stays on the original authorized session or is explicitly invalidated; a late start cannot create a visible attempt under B. Cleanup, when supported/permitted, uses the captured original connection. Manual and automatic callback routes reach the initiating backend; callback parameters and declared paths remain unchanged. A provider-keyed UI attempt map alone cannot represent simultaneous same-provider flows on A and B.

### F. Management success does not prove catalog/plugin reachability

**Verified:** [models.ts:89](/home/swerve/src/prox/src/services/api/models.ts:89) directly requests `/v1/models` with a client API key. Backend [server_routes.go:65](/home/swerve/src/CLIProxyAPI/internal/api/server_routes.go:65) applies its client access middleware there. [nginx.conf:40](/home/swerve/src/prox/deploy/nginx.conf:40) routes management paths; unmatched paths fall through to static files at line 54. Thus the current configuration does not proxy `/claude/v1/models`.

Plugins also use backend-declared paths. [pluginResources.ts:27](/home/swerve/src/prox/src/features/plugins/pluginResources.ts:27) preserves them, and backend [server_management.go:263](/home/swerve/src/CLIProxyAPI/internal/api/server_management.go:263) handles `/v0/resource/plugins/` and custom management extensions separately. These are the sanctioned plugin exceptions, not permission to introduce v0 application fallback. Plugin UI routes currently contain only plugin ID/menu index ([pluginResources.ts:24](/home/swerve/src/prox/src/features/plugins/pluginResources.ts:24)). Plugin store `sourceId` means registry origin and controls trust ([line 72](/home/swerve/src/prox/src/features/plugins/pluginResources.ts:72)); install sends it as `?source=` ([plugins.ts:302](/home/swerve/src/prox/src/services/api/plugins.ts:302)). It must not be repurposed as proxy identity.

**Smallest settling test:** synthetic A/B expose different catalog results and the same plugin ID/menu index. Exercise the generated/relay URLs for management JSON, multipart upload, raw download, `/v1/models`, a declared plugin asset and custom extension. Use distinct synthetic management and client credentials.

**Accept:** each route reaches only its declared source, preserves the backend path and uses the correct authentication contract. Plugin assets/embedded requests must work under the chosen prefix, not merely the initial menu JSON. Installed-plugin navigation retains instance identity; registry trust and install-source selection remain unchanged. Where a backend does not support a feature, expose that source-local limitation rather than borrowing another instance's capability.

### G. Quota occurrence identity, shared allowances and history migration

**Verified:** [collector.ts:91](/home/swerve/src/prox/server/quota/collector.ts:91) hashes provider plus `auth_index`; request routing later uses provider only ([line 375](/home/swerve/src/prox/server/quota/collector.ts:375)). [store.ts:92](/home/swerve/src/prox/server/quota/store.ts:92) retires every row for that provider on each inventory call. Samples refer to account IDs through a foreign key ([line 40](/home/swerve/src/prox/server/quota/store.ts:40)). [domain.ts:169](/home/swerve/src/prox/server/quota/domain.ts:169) builds history from current non-retired membership and adds 100 points per eligible account ([line 303](/home/swerve/src/prox/server/quota/domain.ts:303)). None of these contracts represents a distinct upstream allowance separately from a credential occurrence.

**Executed probes:** sequential successful inventories for synthetic A then B, both Codex with already-distinct IDs, left A retired. Supplying two synthetic occurrence IDs representing the same allowance, each at 70%, produced **200 capacity points / 140 remaining points**. The latter is a contract counterexample, not evidence that any real deployment account is duplicated.

**Smallest settling tests:**

1. In-memory store: complete inventories for A and B, then fail A while B succeeds, then return a complete empty A. Both initially remain active; failure retires neither; empty A retires only A. A mixed-provider source is enumerated completely and sends each quota request back to that source.
2. Domain fixture: two occurrences explicitly known to share one allowance, plus two distinct allowances whose synthetic display emails happen to match. Known duplicates contribute once; equal emails never establish equivalence. With independence unresolved, preserve occurrence visibility and mark combined capacity/forecast unknown or require an explicit allowance-membership policy. Namespacing alone must not claim independent capacity.
3. Migration fixture: seed the old schema with samples for the original Codex/Claude sources, migrate, run inventory, and reopen. Original eligible history, timestamps and sample counts remain available with valid references; no double membership, reset history or fabricated samples. Repeat migration to prove idempotence. A display rename preserves identity. Removal/re-addition or endpoint replacement follows an explicit stable-ID/generation policy rather than silently assigning old history to a different instance.

**Accept:** retirement is scoped to a validated complete source inventory; allowance membership is distinct from occurrence routing identity; migration binds legacy rows to the known original sources or preserves them explicitly as unresolved legacy history. It must not guess mappings from email or filename. Keep these rules in the existing [quota domain owner](/home/swerve/src/prox/server/quota/RULES.md:1), with shared provider-window conversion unchanged unless behavior is separately justified.

## 3. Coverage needed in the implementing decision

| Surface | Required scope/behavior |
|---|---|
| Dashboard | Aggregate inventories/counts with per-source completeness; stale source responses cannot overwrite a new view. Catalog counts need an explicit union-versus-occurrence rule. |
| Providers | Combined inventory is possible; creation targets one instance and edits retain instance plus the existing persisted group/key snapshot. Preserve descriptors and existing conflict checks. |
| Auth Files | Aggregate source-tagged occurrences; normalize within source; selections, details, models, cooldown/reset and every mutation retain ownership. |
| OAuth | Explicit destination when starting; immutable attempt ownership through completion/cleanup. |
| Detailed quotas | Aggregate occurrence cards with source-bound fetching, caches and invalidation. |
| Pooled quotas | Server quota domain owns allowance membership, completeness, history and migration; never add per-source pool totals blindly. |
| Logs | Explicit source is sufficient. A combined view would need separate cursors/buffers; clear/download always target an owner. |
| Config | Exactly one source per document, draft, preview and save. No combined YAML save. |
| Plugins | Inventory may combine; enable/config/install/delete and resource navigation target an instance; registry `sourceId` retains its existing meaning. |
| Catalogs | Source-local endpoints, keys and cache state; union presentation retains which sources provide a model. |

The low-maintenance shared contract is an instance reference plus a session/configuration generation, passed into existing domain APIs. It is not a second set of provider capability rules. The choice between relay and generated routes can remain open until their transport probe passes; the ownership requirements do not depend on that choice.

## Verification performed

- Ran two `bun -e` in-memory probe scripts. Observed credential collapse, cross-source retirement, duplicate allowance summation, late global version events, global captured-client 401, and malformed inventory becoming empty as reported above.
- Ran `bun test tests/managementConnection.test.ts tests/authFilesResponseNormalization.test.ts tests/oauthAttempts.test.ts tests/configDocumentConcurrency.test.ts tests/logRequests.test.ts tests/pluginTrust.test.ts`: **46 passed, 0 failed, 177 assertions**, Bun 1.4.2. These establish existing behavior/guards; they do not verify a future multi-source implementation or browser interactions.
- No generated-routing, relay, migration or browser acceptance tests exist as a result of this review; the tests specified above are acceptance conditions, not completed implementation evidence.

**Decision for the Captain:** reject switcher-only completion. Require the chosen option to answer instance/session ownership and quota allowance/migration explicitly, then proceed with implementation. No additional architectural objection survives once those concrete contracts and transport coverage are included.
