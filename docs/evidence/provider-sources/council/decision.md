# OMO Council — Prox provider source ownership

**Headline:** One source list fixes discovery only when every resource and operation keeps its owning instance; provider names cannot supply that identity.

**Brief:** Make all Prox surfaces consume one authoritative, enumerable inventory of compatible proxy instances, show all authenticated credential occurrences, and preserve correct read/write ownership as more instances are added.

**Option space:** (1) global switcher everywhere; (2) browser enumeration with scoped APIs; (3) server registry and general relay; (4) deployment manifest generating routing/discovery and collector input, combined with scoped browser APIs.

**Phase 0 reframe:** Give every page one authoritative inventory of compatible proxy instances, preserving each resource's source identity and routing operations to its owner while retaining resource-specific aggregation rules. The existing implementation and constraints are recorded in [the shared brief](brief.md).

## Phase 1 — Captain's assignments

The question reduced to internal ownership and routing, so the council used Lean++ with three parallel seats:

- **Delphi:** choose the implementation boundary, resource scopes, migration sequence, and first empirical proof.
- **Explorer:** trace every UI/API/cache/action path, backend v8 contracts, and deployment constraints.
- **Momus:** try to falsify ownership, session isolation, bulk operations, routing, and history preservation.

## Phase 2 — Parallel positions

- **Strategist:** [option 4 plus scoped API factories](phase2-delphi.md#1-decision-and-concrete-ownership). Keep the existing Nginx transport and server-owned quota domain; avoid a general credential-brokering relay.
- **Internal researcher:** [the call-graph audit](phase2-explorer.md#2-ui-surface-call-graphs) found one mutable management connection, independently configured quota collection, and source assumptions in layout/background consumers as well as pages. Pagination does not explain missing Claude inventory. Live routing observations are limited; deployed credentials, plugin behavior and key sharing remain unverified.
- **Execution adversary:** [ownership counterexamples](phase2-momus.md#2-falsification-cases-and-acceptance-conditions) reproduced raw inventory collisions, cross-source retirement, duplicate allowance summation, global response-event contamination and malformed successful inventory becoming empty. Its 46 passing focused tests describe existing behavior, not a verified new implementation.

## Phase 3 — Cross-attack

[Delphi modified the proposal](phase3-delphi.md): preserve existing source-local quota behavior, rather than requiring universal allowance identity before displaying working quotas; require explicit operation/session ownership through nested requests; and treat unproven plugin embedding as unsupported instead of assuming a prefix makes it safe. The challenge included Momus's reproductions and Explorer's additional API-key-bearing inventory and xAI inference-fallback findings.

## Synthesis

**Decision:** Implement option 4 plus source-scoped API factories. A validated deployment manifest is the sole source of instance membership, aliases, browser routing, authentication-sharing declarations and collector origins. Generate sanitized discovery and fixed routing from it. Existing domain owners retain normalization, calculations, capability rules and operation semantics.

**Why:** The deployed routing already reaches both instances, but Auth Files and other ordinary management consumers read one active connection. The [audit's shared-transport findings](phase2-explorer.md#1-shared-transport-identity-and-refresh) and [reproduced failures](phase2-momus.md#2-falsification-cases-and-acceptance-conditions) show why concatenating lists or switching the singleton cannot meet the requested behavior. The manifest hybrid removes competing source lists without adding a general management relay.

**Survival Score: Modified.** The architecture survived, while real objections changed the operation contract, quota policy and plugin acceptance boundary. This is a reviewed design, not a claim that its enforcement or implementation already exists.

### Implementation contract

1. **One instance owner.** Stable instance IDs are independent of provider kind, labels and address. Canonical root/Codex aliases resolve to one instance; a mixed-provider instance is enumerated once. Public discovery is an allowlisted projection of deployment configuration, never backend inventories or credentials. Preserve an explicit external single-backend path without mandatory discovery.
2. **Pinned operations.** Extend the existing API transport with an immutable instance/session-epoch/source-generation owner, abort signal and currentness guard. Capture it when work or a confirmation starts. Check before dispatch, after awaits, at queue dequeue and before publication. Scoped domain implementations and their transitive request helpers cannot import the ambient singleton; enforce that boundary with a dependency check and nested-chain tests. Keep source selection distinct from source lifetime. A stale/missing owner never falls back to the selected source.
3. **Scoped state and outcomes.** Partition caches, in-flight requests, queues, capabilities, authentication and invalidation by owner. A secondary 401 cannot log out a healthy source. Normalize and validate each inventory before combining. Preserve complete-empty, unavailable, malformed, stale and partial states. Dispatched mutations with uncertain results require reconciliation under their original owner.
4. **Resource-specific UI scope.** Aggregate compatible credential/provider/installed-plugin inventories, detailed quota cards, and explicitly defined dashboard observations with source provenance and completeness. OAuth, uploads, config drafts, log cursors, plugin installs, resource navigation and system actions have explicit destinations. Every row action and drilldown retains its owner. A frozen bulk scope groups existing source-qualified targets and reports per-owner successes, failures and unknown outcomes; it never grows when sources are added. The full surface matrix in [the strategist report](phase2-delphi.md#2-routeaction-matrix) applies, with the quota/plugin amendments below.
5. **Preserve quota meaning and history.** Keep existing source-local unweighted credential-normalized points and quality rules. Multiple sources of one provider get separate source-local results; their combined numeric capacity, balance, rates and forecast remain unavailable with an explicit reason, rather than summing unverified allowances. Preserve all credential observations and history. Do not infer duplicates from email, filename, plan or auth index. A genuinely confirmed duplicate membership suppresses only the affected pooled arithmetic; universal identity discovery and representative-stream aggregation are outside this change. These decisions belong in the quota domain, not UI rendering or the registry. Follow [the revised quota policy](phase3-delphi.md#2-smallest-truthful-quota-policy).
6. **Source-scoped persistence.** Retire only the instance/provider inventory that completed successfully. Migrate legacy attribution transactionally using explicit prior-deployment provenance, retaining old account IDs and every sample foreign key/tuple. Unmapped legacy data remains retained and unresolved. Preserve existing source-local outputs, timestamps, retention rules and gaps. Source-qualified new IDs cannot claim another instance's history. Test reopen/idempotence, rollback and failures before any live migration.
7. **Transport classes remain distinct.** Generate fixed management routes, the client-key models endpoint, and specifically declared plugin exceptions. Do not expose broader inference routes or inject management keys into resources. Prove plugin initial and nested requests retain their owner. Unproven embedding has an explicit unsupported state, while supported management operations remain usable. A dedicated resource origin can be represented only if explicitly configured and verified; this change assumes no new DNS, TLS or listener authority. Preserve external single-backend resource behavior.
8. **Enumeration is passive inventory work.** Discovery/inventory refresh must not automatically dispatch quota adapters, xAI inference fallback, credential downloads, refresh queues, reset/grant actions or inference. Existing explicitly authorized provider operations remain available through their captured owner. Test secret sentinels and nested API-call payloads; a raw credential response is not a safe UI/evidence DTO.

**Trade-offs accepted:** No combined same-provider quota forecast without an established combination policy; plugin embedding may remain unsupported where transport compatibility is unproven. The source-local results and supported operations remain available. This avoids replacing an observable incomplete view with a plausible but incorrect aggregate.

**Second-order consequences:** Adding an instance changes one manifest and reuses existing domain APIs. Adding a provider-specific quota rule still belongs to that provider's domain adapter. The new contract must not become a second provider-capability framework.

**Open risks:** Transitive singleton imports, source changes during multi-step work, already-dispatched unknown mutation outcomes, and live plugin/callback/key-sharing compatibility. [Phase 3](phase3-delphi.md#new-risk) explicitly limits the prototype's claims: synthetic proof does not verify deployed entitlement scopes, callback ports, credentials or dynamic plugin behavior. The current config patch executor does not send If-Match; preserving its guards is not a claim of ETag enforcement.

**Dissent on record:** Switcher-only completion was rejected. Momus's ownership objection remains an implementation acceptance gate, resolved in the design but not yet proven in code. The architect withdrew the broader quota-identity prerequisite after challenge. No competing architecture remains proposed after the cross-attack.

## Implementation and verification order

1. Commit behavior-preserving extraction of source definitions and injected APIs; compare single-source output fixtures.
2. Prove synthetic A/B same-provider and C mixed-provider enumeration, source-bound mutation, delayed/ABA session isolation, partial/401/malformed inventories, and generated transport classes.
3. Migrate all audited surfaces through those contracts, including layout counters/menus, background refresh, nested helpers and store invalidation.
4. Migrate collector/store identity and expose source-local pools while preserving historical samples and current single-source results.
5. Run focused boundary tests, full repository verification, transport and browser acceptance, then finish the remaining visual-review issues and publish the reviewed changes.

The detailed acceptance cases in [Phase 3](phase3-delphi.md#5-first-vertical-slice-and-implementation-boundaries) are requirements to implement, not completed checks. Production migration needs the repository's backup/rollback procedure and live verification when authorized. LAN listeners, GPT/Codex8317, Claude/Claude Code8319 and existing history aliases remain intact.

## Spec-verifier gate

Not applicable: no OpenSpec change has been created. The decision and owning rules documents will define the implementation contract; tests enforce its boundaries.

## Decision drive-through

**Status:** IN PROGRESS — synthesis verified; implementation beginning with transport extraction and source contracts.
**Branch:** `feat/prox-quota-visual-polish`, preserving committed UI work at `36e2d79` and subsequent review artifacts.
**PR:** not created; no merge or deployment performed.
**Post-merge reset:** not applicable.

## Appendix

**Decision crux:** Can every enumerated resource retain its exact owning instance and current operation through all asynchronous paths?

**Missing information:** Live key-sharing, concrete plugin-resource compatibility and OAuth callback reachability remain unverified. They may gate enabling those live capabilities; none blocks the synthetic source/ownership prototype.

**Token cost:** Not measured across child runs; no precise usage claim is available.

Synthesis verified by omo-judge (1-pass). All four truthfulness checks passed; the verdict does not certify implementation.
