# OMO Council: credential changes reach every screen at once

**Headline:** Prox doesn't need a credential manager. It already has one store per proxy (each CLI-Proxy's auth files). What's missing is one versioned read model of that store, plus a single commit that every metadata screen reads from. Today five screens fetch the list separately, one listener hears the change event, and the quota history waits up to 5 minutes.

**Brief:** The user's words: "Remove everywhere, at once"; "remove auth event should populate throughout the entire UI in one go"; "anything that is a direct metadata/config screen should be updated" (Analytics request, usage and dollar metrics may keep history); "test everything around adding or removing credentials"; and move the architecture toward "event driven sequences and centralized sources that are easy for things to read from".

**Option space:**
- (a) Push deletion signals to each copy.
- (b) Faster reconciliation against the CLI-Proxy inventory.
- (c) A new central credential-registry service.
- (d) A hybrid: reconciliation for correctness, plus an immediate sync from the acting tab.
- Transport: SSE versus version polling with ETags.
- Data: retire, scrub, purge or tombstone.

**Phase 0 reframe (omo-sophia):** There is one source of truth per proxy and several derived copies (Prox SQLite, collector memory, cpa-manager-plus). The design question is how a change at the source retires or purges each copy, not how to centralize the stores.

## Phase 1: assignments
- **omo-vulcan:** strongest concrete implementation, data-structure changes and an end-to-end proof without touching real credentials.
- **omo-delphi:** which of (a)–(d) to pick, the minimum data change, what the UI shows between delete and purge, and the event-driven flow end to end.
- **omo-archivist:** CLIProxyAPI delete and change signals, how cpa-manager-plus handles deletes, and prior art.
- **omo-explorer:** every screen's data source and refresh path, the add/remove call graphs, the server inventory path and existing tests.
- **omo-momus:** executability: routes, mounts, rate limits, purge fallout and SSE through nginx/Bun.

## Phase 2: positions (summary)
- **omo-explorer:**
  - Five or more screens fetch `/credentials` separately: `useAuthFilesData.ts:229`, `QuotaPage.tsx:146`, `useDashboardOverview.ts:157`, `MainLayout.tsx:433` and `PoolAccountResets.tsx:153`.
  - The one change event, `AUTH_FILES_CHANGED_EVENT` (`authFilesEvents.ts`), has one listener (`MainLayout.tsx:458`, the sidebar badge).
  - `#/quota` reads prox-history, which changes only on the 5-minute collection. `POST /v1/refresh` is silently skipped within 4 minutes (`collector.ts:357-362`).
  - The Accounts page and Dashboard never refresh on their own.
  - There is no push transport, no version and no ETag. No test covers propagation across screens.
- **omo-archivist:**
  - The CLIProxyAPI delete removes the `.json` file and its runtime record, never the `.lock`, and emits no event. Each auth-file entry carries `modtime`.
  - cpa-manager-plus (seakee/CPA-Manager-Plus, local fork image) has no purge API and only knows about deletes made through its own proxy.
  - Prior art says events should be invalidation hints and reconciliation is the truth (TkDodo: invalidate on events rather than patch the cache; Kubernetes: list-watch plus resync).
- **omo-momus:** The core is executable through existing routes (`/v8/management/prox/` → `18319/v1/`). Its objections:
  - prox-history can't delete `.lock` files (no auth-dir mounts), and no screen shows them.
  - A re-sync needs a new inventory-only path, because `refresh()` is rate-limited and also polls usage (429 risk).
  - `EventSource` can't send the Bearer header, so use version polling.
  - Bun's default idle timeout would hurt SSE.
  - Purging needs child-first deletes (`foreign_keys = ON`). Scrubbing PII is safer than deleting rows.
- **omo-delphi:**
  - Option (d). prox-history is the central read model, with an inventory revision.
  - New `GET /v1/inventory` (ETag/304) and `POST /v1/reconcile`, inventory-only and outside the 4-minute limit.
  - One browser store committed in a single `set()`, polling every 5 s while the tab is visible.
  - Retire now and purge after a grace period. No registry service and no cpa-manager-plus coupling.
- **omo-vulcan:**
  - The same shape, with a content-hash version, a sync endpoint the acting tab awaits before committing, and `forget(ids)` for the collector maps.
  - Two races: an `inventorySeq` guard against a stale collection re-adding an account, and a liveness check before writing samples so a purged id can't fail the whole collection.
  - BroadcastChannel for other tabs, and add/remove Playwright flows against a fake CLI-Proxy.

## Phase 3: cross-attack
- **omo-vulcan updated:**
  - Scrub on every retire.
  - Purge right away only rows the user deleted by name in Prox that a fresh validated inventory confirms are gone; otherwise purge after 24 h.
  - Defer the `.lock` fix and cpa-manager-plus.
  - Crux: absence from one inventory isn't proof of intent, so only reversible steps follow from absence alone.
- **omo-delphi updated:**
  - Scrub email and name at retire, since keeping them for 24 h breaks "gone everywhere".
  - Keep a single purge path after a short grace period (1 h).
  - Adopt the `inventorySeq` guard, the liveness check and BroadcastChannel. Keep 5 s ETag polling.
  - Crux: "gone everywhere" means the user can no longer see or identify the account (scrub), and the rows are gone shortly after (grace purge), without one bad empty inventory erasing history.

## Architecture flow, evaluated end to end

**Current (verified):**
1. **CLI-Proxy:** each instance's auth-files directory is the only credential store: Codex on :8317 from `~/.local/share/cli-proxy-api/auth`, Claude on :8319 from `~/.local/share/cli-proxy-claude/auth`. Deletes remove the `.json` file and its runtime record, never the `.lock`, and emit no event.
2. **Browser to CLI-Proxy, directly through nginx** (`deploy/provider-routes.conf`). There is no Prox application server in between. Each screen lists `/credentials` itself:
   - Auth Files: `useAuthFilesData.ts:229`
   - Accounts: `QuotaPage.tsx:146`
   - Dashboard: `useDashboardOverview.ts:157`
   - Sidebar badge: `MainLayout.tsx:433`
   - Reset rows: `PoolAccountResets.tsx:153`
3. **Browser to prox-history** (`/v8/management/prox/` → `127.0.0.1:18319/v1/`): Quota Management reads `/v1/pools`, which comes from SQLite. That data changes only on the 5-minute collection, and a manual refresh within 4 minutes is ignored.
4. **Change signal:** `AUTH_FILES_CHANGED_EVENT` is a same-tab window event with one listener, the sidebar badge.
5. **cpa-manager-plus** (the user's fork, SwiggitySwerve/CPA-Manager-Plus, deployed at b59df335) reads the Claude CLI-Proxy on its own and keeps its own account-keyed tables. Prox only reads Analytics from it (`server/analytics/handler.ts`; Prox's Analytics reads no quota tables).

**Problems with this flow:**
- Five or more independent fetches.
- Four different refresh schedules.
- No version, so a screen can't tell that the inventory changed.
- No server-side sync path.
- One listener.

**Target:**
1. **CLI-Proxy** stays the store.
2. **prox-history** owns the one inventory read model and its version.
3. **One change event** comes from a Prox add/remove (awaited sync), from another tab (BroadcastChannel) or from an outside change (5 s ETag poll).
4. **One browser store** commits every slice at once.
5. **Every metadata screen** reads that store.
6. **A janitor** removes orphaned `.lock` files when the auth directories change.
7. **cpa-manager-plus** reconciles its own account metadata against the same inventory.

## Synthesis
**Decision:** Build option (d) in two PRs.

**PR A (prox repo):**
- prox-history keeps the credential-inventory read model with a content-hash version.
- A new inventory-only sync runs immediately when Prox adds or removes a credential.
- One browser store fetches every slice and publishes it in a single commit, and every metadata/config screen reads from it.
- Update paths:
  - Tabs in the same browser are nudged at once over BroadcastChannel.
  - Other devices, other browsers and changes made outside Prox are picked up by a 5-second ETag poll.
- Lifecycle on retire:
  - Prox scrubs the account's email and name and clears collector memory.
  - Accounts the user deleted by name in Prox are purged as soon as a fresh validated inventory confirms they are gone.
  - Accounts that merely disappeared are purged after 24 hours.
- A user systemd path unit, installed by the deploy script, removes `.lock` files whose `.json` is gone whenever either auth directory changes.

**PR B (CPA-Manager-Plus fork):** cpa-manager-plus becomes another reader of the same central source.
- It polls the CLI-Proxy credential listings it can already reach (Codex and Claude) every 5 s and computes the same kind of membership version from them. prox-history listens only on the host's loopback, which the cpa-manager-plus container can't reach. Both read models therefore derive from the one source, the CLI-Proxy auth files, rather than one calling the other.
- On a version change it reconciles its account-keyed metadata (cooldowns, inspection records and any account-candidate rows, once the screen inventory confirms which exist) so removed credentials leave its metadata screens within about 5 s.
- Its usage, request and dollar history stays.

**Why:**
- The CLI-Proxy auth files are the only real credential store. A registry would be a second writer that still has to reconcile.
- Reconciliation catches changes made outside Prox. The acting tab awaits the sync, so it has no lag.
- A single client commit is the only way to guarantee "no screen lags another".
- Scrubbing at retire removes everything identifying at once, and it can be undone if the account comes back.
- Purging differs by evidence of intent:
  - An explicit delete plus a confirming inventory purges immediately, which meets "gone everywhere".
  - Absence alone (which an unmounted auth directory would also produce) only hides and scrubs, and purges after 24 hours. That leaves a day to notice and remount before history is lost. It is a delay, not a guarantee.
- The leftover `.lock` file and cpa-manager-plus's copies are in scope, as the user chose "remove everywhere".

**Survival Score:** Modified. Four live objections changed the plan:
- Scrub at retire was added.
- `.lock` cleanup moved from prox-history (no mounts) to a host-side janitor.
- SSE was replaced by ETag polling (EventSource can't send the Bearer header).
- The two race guards were added.

The purge-timing split was settled by taking omo-vulcan's intent-based rule: immediate purge for named deletes, 24 h for absence. omo-delphi's single 1-hour path was dropped.

**Trade-offs accepted:**
- Other devices, browsers and outside changes can be up to about 5 s behind. Every screen on a device is equally behind, because all read one store.
- Rows of accounts that merely disappeared linger, anonymized, for 24 hours.
- Removed accounts already drop out of past pool capacity (today's behaviour).
- cpa-manager-plus changes ship as a second PR in its own repo. Its screens update within about 5 s of the change, the same bound as other devices, not in the same frame as the acting Prox tab.

**Second-order consequences:**
- New metadata screens read the store instead of fetching their own lists.
- `/v1/inventory` becomes the one place to ask "what accounts exist".
- The 5-minute collection becomes a safety net, not the propagation path.

**Open risks:**
- Whether CLI-Proxy lists `.lock` entries (the inventory must ignore non-`.json` names).
- How cpa-manager-plus's own account screens behave after a delete.
- A browser tab that's hidden pauses polling and catches up when it's visible again.

**Dissent on record:** omo-delphi preferred one purge path with a 1-hour grace ("once the PII is scrubbed, what's left is an anonymous digest plus samples"; a second path "the outside-delete case never uses"). It was declined: absence alone is not proof of intent, so irreversible deletes follow only an explicit delete or a 24-hour grace.

## Requirements (the implementation must satisfy these)

1. **Server inventory read model (prox-history):**
   - `syncInventory()` re-reads every source's `/v8/management/credentials` using the existing validation (`inventory()`). It is single-flight with a 1-second floor and is not subject to the 4-minute manual limit.
   - It never calls provider usage APIs.
   - A failed or malformed inventory retires nothing (keep `server/quota/RULES.md`).
   - It ignores non-`.json` names.
2. **Version:** `inventoryVersion` = sha256 (truncated) of the sorted `[instanceId, provider, accountId, disabled]` for active accounts. It contains no names or emails and is also returned on `/v1/pools`.
3. **Routes:**
   - `GET /v1/inventory` → `{version, syncedAtMs, sources:[{instanceId, provider, state, accounts:[{accountId, sourceAccountId, disabled}]}]}`. It sends an ETag, answers `If-None-Match` with 304, and reconciles lazily if the last sync is more than 5 s old.
   - `POST /v1/inventory/sync` takes the body `{reason: 'add'|'delete'|'change', deletedNames?: string[] (credential file names, at most 200)}` and returns `{version, added, removed}`. It reuses the bounded JSON parsing of `/v1/refresh`.
   - Both are behind the existing bearer auth.
4. **Lifecycle:**
   - On retire, set `email = NULL`, a neutral `name` and `retiredAtMs` (a new column added by a guarded `ALTER TABLE`), in the same transaction.
   - Re-adding the account restores them.
   - `POST /v1/inventory/sync` accepts the deleted credential names. Rows that are named and also absent from the fresh validated inventory are purged immediately, children first (samples, plans, sources, accounts).
   - `prune()` purges other retired accounts 24 h after `retiredAtMs`.
   - Existing retired rows are backfilled, so they scrub now and purge after 24 h.
5. **Collector:**
   - `forget(ids)` clears every per-account map and aborts in-flight polls.
   - A per-source `inventorySeq` stops a stale inventory read from re-adding an account.
   - A liveness check before persisting samples or setting map entries.
   - Newly added accounts get one targeted first poll.
6. **Client:**
   - One `useCredentialInventoryStore` holds the version, the per-source credential files and the pool dashboard. On a version change it fetches all of them in parallel and publishes in one `set()`.
   - `notifyAuthFilesChanged` awaits the sync, bumps the store and posts on a BroadcastChannel. It keeps the window event. Every add and remove path already calls it:
     - OAuth completion (`useOAuthFlows.ts:156`), SIWC bind (`SiwcBindDialog.tsx:131`) and Vertex import (`useVertexImport.ts:74`).
     - Upload (`useAuthFilesData.ts:324`) and the field patch editor (`useAuthFilesPrefixProxyEditor.ts:771`).
     - Single, bulk and batch delete (`useAuthFilesData.ts:361,445,962`).
     - Delete-all (`authFiles.ts:665`) is wired in too.
   - One poller, hosted in `MainLayout`, polls every 5 s while visible and pauses while hidden.
   - Auth Files, the Accounts page (`#/quota/accounts`), Quota Management (`#/quota`, including per-account reset rows), the Dashboard credential counts, the sidebar badge and the OAuth model alias/excluded edit pages all read from the store. Their own list fetches are removed.
   - AI Providers (`#/ai-providers`) and its provider sheets list API-key provider entries from config, not credential files (`useProviderWorkbench.ts:495`), so a credential change doesn't touch them. The tests assert that they stay unchanged.
   - Derived-cache invalidation runs inside the commit for removed names.
   - Delete-all fires the event too.
7. **Analytics** keeps its history, unchanged. It comes from cpa-manager-plus through `server/analytics/handler.ts` and reads no quota tables, so purges don't affect it.
8. **Lock janitor:** a `prox-auth-janitor.path` user unit watches both auth directories and runs a script (plus a 15-minute timer as a backstop). The script deletes `*.json.lock` files that have no matching `.json` and are older than 10 minutes. The age limit is there because CLI-Proxy's `WithFileLock` creates the `.lock` (`O_CREATE`) before writing, so a fresh orphan lock can belong to a write in progress. The script never touches `.json` files. Its tests cover: an old orphan is removed, a fresh orphan is kept, and a lock with its `.json` is kept. It is installed by `scripts/deploy-homelab.sh`.
9. **PR B (CPA-Manager-Plus):**
   - Inventory which of its screens list accounts or credentials.
   - Poll prox-history `GET /v1/inventory` (ETag, 5 s) as a consumer of the central source.
   - On a version change, reconcile its account-keyed metadata.
   - Keep usage, request and dollar history.
   - Add tests in that repo.
10. **Tests:**
   - **Store and collector unit tests:** retire, scrub, purge, re-add; seq race; poll after purge; version stability; failed inventory doesn't retire.
   - **HTTP tests:** ETag/304, sync bypasses the 4-minute gate, no PII in the inventory.
   - **Playwright, against a fake CLI-Proxy plus the real store and collector:**
     - Remove: every screen updates at once, the same-email credential on the other provider stays, and Analytics totals don't change.
     - Add: every screen shows the new credential at once.
     - External change: picked up by the poll.
     - Second tab: updated through BroadcastChannel.
     - AI Providers (`#/ai-providers`): its list is identical before and after the add and the remove.
     - 503 inventory: nothing retires.

## Follow-ups
- CLI-Proxy fork: unlink `<file>.lock` on delete at the source. The janitor already covers this until then.

---
*Synthesis revised twice after omo-judge REVISE passes (scope, grounding, dissent, janitor safety, CPA immediacy).*

*Appendix*
- **Decision crux:** whether one change can be committed to every screen at once. That needs a single client store, not more listeners.
- **Context factors:** a single host, a Bearer-key API, CLI-Proxy has no change events, and cpa-manager-plus is a separate app.
- **Missing information:** whether CLI-Proxy lists `.lock` entries, and which cpa-manager-plus screens the user uses.
- **Token cost:** about 600K across the seats.
