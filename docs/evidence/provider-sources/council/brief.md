# Prox provider source council

User request: audit and fix provider data from proxy instances through every app
layer. Establish one authoritative, enumerable source setup that supports multiple
compatible instances (including several of the same provider) and can serve all
UI elements. Auth Files currently shows Codex only even though Claude is on the
separate proxy. Preserve the existing UI improvement branch.

Phase 0 reframe: Fix Prox's incomplete provider visibility by giving every page
one authoritative inventory of compatible proxy instances, preserving each
resource's source identity and routing operations to its owner while retaining
resource-specific aggregation rules.

This is a bounded internal architecture problem. Use the Lean++ council:
strategist, internal evidence researcher, and execution adversary. External
research is not needed unless primary local evidence reveals an unresolved gap.

## Options to evaluate

1. Extend the existing global active-source switcher to every page. This is a
   compatibility baseline; determine where it fails the user's aggregation goal.
2. A shared source registry with browser-side enumeration, scoped API factories,
   and per-resource aggregation.
3. A server-owned registry and source-scoped management relay, with domain-specific
   aggregate reads and explicitly targeted writes.
4. A hybrid: authoritative deployment manifest, generated proxy routing/discovery,
   and scoped browser clients plus existing quota-domain aggregation.

Do not assume provider kind identifies an instance. A compatible instance may
contain several provider kinds, and several instances may contain the same kind.
Choose a concrete implementation boundary with the lowest maintenance cost.

## Verified phase 0 findings (independently recheck relevant claims)

- deploy/nginx.conf forwards ordinary root management requests to port 8317,
  Claude sibling management requests to 8319, and all three pooled-history routes
  to one history service. No single authoritative source inventory currently
  serves deployment routing, the collector and the UI.
- src/features/quotaPool/runtimeConnection.ts recognizes only same-origin root,
  /codex and /claude. ManagementRuntime is rendered only for detailed quotas and
  logs in src/components/layout/MainLayout.tsx, not Auth Files.
- src/services/api/client.ts owns revisions and captureConnection(); response
  side effects currently include global unauthorized/version/plugin events.
  src/stores/useAuthStore.ts clears config, model and quota caches during login.
- src/services/api/authFiles.ts normalizes one backend's credentials. Its API
  operations use the singleton client. src/features/authFiles/hooks/
  useAuthFilesData.ts reads one inventory and selects by filename.
- src/utils/quota/identity.ts ordinarily uses filename as cache identity, with
  special multiple-identity rules for Devin/plugin credentials. Combining lists
  before normalization can collapse unrelated source-local resources.
- server/quota/collector.ts hardcodes provider list and one origin per provider.
  Pool IDs hash provider plus auth index. server/quota/store.ts recordInventory
  retires all accounts for that provider. Naively looping over multiple sources
  would let one retire another's accounts. Existing history needs a migration
  policy if identity changes.
- A credential occurrence is not proof of a distinct upstream allowance. Source
  namespacing prevents identifier collisions but does not solve repeated account
  capacity. Do not deduplicate by email or invent independent quota capacity.
- Failed inventory must not become a successful empty list. A secondary source's
  401 must not log out a healthy primary session. Never fall back to another
  source for a mutation whose owner is unavailable.
- Existing domain ownership remains: server/quota/RULES.md, server/quota/domain.ts,
  src/domain/quotaWindows/{claude,codex}.ts; provider form capabilities belong to
  src/features/providers/descriptors.ts, not a deployment registry.
- OAuth destinations must remain stable through start/poll/callback/cancel.
  Config drafts/previews/saves need one explicit source. Logs have source-local
  cursors and clear/download actions. Plugin registry sourceId already has a
  different meaning from proxy-instance identity.
- src/services/api/models.ts reads /v1/models with a client API key; current
  management-only routing does not prove catalog or plugin resource reachability.
- The neighboring CPA-Manager-Plus owner resolver offers behavioral precedent in
  apps/manager-server/internal/service/proxy/multi_upstream.go, but its v0 API and
  shared-key assumptions are not a compatible transport to copy into Prox v8.

## Required breadth and verification

Inventory/read/identity/cache/error/mutation contracts across Dashboard, Providers,
Auth Files, OAuth, detailed and pooled Quotas, Logs, Config, Plugins and catalogs.
Define which views aggregate and which require an explicit source. "All" bulk
operations need explicit scope and partial-result behavior. A switcher alone or
an architecture document without visible behavior fixes is insufficient.

Use synthetic tests for two sources of one provider, a mixed-provider source,
colliding filename/auth-index values, repeated upstream identity, inventory
outage/401, source switch including ABA during work, partial bulk failure, and
history preservation. Preserve arbitrary external single-backend connections.

## Constraints and current state

Repo /home/swerve/src/prox, branch feat/prox-quota-visual-polish, head 36e2d79.
No production changes or live credential mutations are authorized in this council
research phase. Keep LAN access and GPT/Codex8317 vs Claude/Claude Code8319 split.
Credentials remain on their existing instances. Do not dump/read credential file
contents, management/access keys, or personal account identities. Inspect code and
non-secret routing metadata. Do not consume quota refresh/usage queues or inference.
No app edits, commits, browsers, deployments, subagents, or reading another seat's
output during Phase 2. All three visual-review JSONs are unrelated; preserve them.

The council will implement the chosen design after evidence and objections are
resolved. Cite only verified paths and symbols; mark unresolved claims clearly.
