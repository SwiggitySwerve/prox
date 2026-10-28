# OMO Council — Provider sections and the data flow to the UI

**Headline:** AI Providers is empty because it answers the wrong question. In fill-first mode, a "provider" is really an ordered queue of accounts. The page should show that queue for each proxy: OAuth accounts and API keys together, in the order the scheduler will actually use them. Building it needs one more read per page plus a pure ordering function, not a new data layer.

**Brief:** Decide what each provider section in prox should show and how proxy data should flow into it. Set out the design in detail.

**Option space:**
- **A.** Read-only OAuth roster per proxy, shown above the existing API-key editor. Edits deep-link to Auth Files.
- **A-merged.** A, plus API keys interleaved in the true routing order.
- **B.** Sections per provider type, spanning both proxies. The RULES forbid this.
- **C.** A unified, editable Provider entity.
- **D.** Data flow through a shared per-source inventory cache.
- **E.** The Bun history server aggregates the inventory.
- **F.** Copy-only fix ("API keys 0 · OAuth accounts N").
- **G.** Rename the page to "API-key providers" and change nothing else.

**Phase 0 reframe:** prox has no shared per-source inventory, and AI Providers reads only `api-keys`. The open questions were therefore which per-source model should feed the pages, and which pages should treat OAuth accounts as providers.

## Phase 1 — Captain's assignments
- **omo-vulcan:** concrete section layout, fields and states from the real backend payload; end-to-end data flow with TypeScript shapes; file order and tests.
- **omo-delphi:** which page answers which question; shared cache vs per-page fetch vs server aggregation; sequencing and revisit triggers.
- **omo-archivist:** upstream status, prior art from comparable gateways, data-flow patterns.
- **omo-explorer:** backend contract, selector semantics, every frontend fetch path, the providers page today, what the Bun server holds.
- **omo-momus:** executability of D1 (roster), D2 (shared cache), D3 (server aggregation) and D4 (copy fix).

## Phase 2 — Parallel positions (condensed)
- **vulcan:** read-only "Accounts" block per source, with a precise state machine and a "next pick (predicted)" line, introducing a shared owner-keyed `CredentialInventoryResource` now. About 600 lines of code plus 400 of tests.
- **delphi:** one question per page. AI Providers becomes the routing view; edits stay on Auth Files. Per-page scoped fetch plus a pure `buildSourceRoster`, no cache and no server aggregation for now. Merge API keys and OAuth accounts by priority. Slice 1 is a copy-only fix.
- **archivist:**
  - Upstream AI Providers is still API-key only. Issue #271, asking for OAuth accounts in priority sorting, was closed without a change.
  - The closest prior art is sub2api (OAuth subscription pools): a platform grouping over an account table with priority, a computed status ("rate limited until…") and usage windows. Sticky sessions beat priority there too.
  - new-api and LiteLLM use TanStack Query with keys per identity.
  - No gateway exposes "who serves next"; each one infers it.
- **explorer:**
  - `GET /v8/management/credentials` returns `id, auth_index, provider, status, status_message, disabled, unavailable, next_retry_after, priority, cooldowns[] {scope, model_key, reason, retry_at, remaining_seconds}, success/failed, recent_requests`, plus an `observed_at` envelope.
  - The selector uses the highest-priority bucket first, then breaks ties by ascending `id`. Cooldowns are per model. Session affinity binds per provider, session and model, and beats priority.
  - No endpoint exposes the current or next account, or affinity bindings. `/observability/usage/queue` is destructive and must never be called.
  - Five independent `/credentials` fetchers exist.
  - `~/bin/cli-proxy-rerank`, on a 10-minute systemd timer, rewrites priorities to `max(100 - 10i, 1)`, ranked by soonest weekly reset with limited accounts last.
  - `PoolAccount` has no join key to the credential list.
- **momus:**
  - D1 is executable with fixes: order by `id`; the pool API is not source-scoped and has no join key; `tests/providerSourceWorkbench.test.ts:557-570` forces the new read into a separate hook; the scope needs `createAuthFilesApi`; never POST `/prox/refresh` from this page.
  - D2 is executable only in a reduced form, owned by the registry lifetime.
  - D3 is blocked: 5-minute staleness against cooldowns that change by the second, and the schema has no fields for it.
  - D4 cannot show N without the list fetch.

## Phase 3 — Cross-attack
- **vulcan:**
  - Withdrew the shared cache: one consumer, `AUTH_FILES_CHANGED_EVENT` already gives freshness, and the rerank makes TTL caching irrelevant to correctness.
  - Accepted the merge. Verified that API keys and OAuth accounts for a provider share scheduler buckets (`synthesizer/config.go:207`, `file.go:109`, `scheduler.go:1323-1333,1601`). API keys are not in `/credentials`, so they are joined from config. Because the rerank floors priority at 1, a default-0 API key is always the fallback after every OAuth account.
  - Corrected the "next" rule: it depends on the size of the top ready bucket, not on the strategy name. With session affinity on, the order applies to new sessions only.
  - Crux: the roster must reproduce the scheduler's rule at a stated time. Caching affects speed, not correctness.
- **delphi:**
  - Moved the cache to slice 2, once Dashboard, the sidebar and AI Providers all consume it.
  - The stale sidebar bug is a missing `notifyAuthFilesChanged` in `handleStatusToggle` and `handleCooldownReset`, so ship that fix on its own first.
  - Dropped the copy-only slice 1, since it needs the fetch anyway.
  - Merge is real at runtime, but with zero API keys merged display is no longer required. The builder stays kind-agnostic.
  - Don't name the rerank job in the UI. Caption: "Order as of HH:MM; priorities may be changed externally."

**Captain's live check (2026-10-28, `GET /v8/management/credentials` on both proxies):**
- Codex: 100 and 90, both active.
- Claude:
  - account 1 is at 100 and active;
  - account 2 is at 100 but `unavailable`, with a credential-scope `credential_quota` cooldown of about 85 hours (model-scope `quota` 429 on one model);
  - account 3 is at 90 and `unavailable`, with a credential-scope `credential_quota` cooldown of about 20 hours (model-scope `quota` 429 on one model).
- Two of the three Claude accounts are drained, and one drained account still holds priority 100. That confirms rows must be sorted by state before priority, and that priority alone is misleading.

## Synthesis

**Decision:** Make AI Providers the per-proxy routing view.

Each proxy section gets a read-only **routing roster**: every credential that can serve that proxy's provider, grouped by provider family, ordered by the scheduler's actual rule. Each row has one state chip, and the roster is stamped with its fetch time and the session-affinity caveat. The existing API-key editor stays underneath, unchanged except that its header is renamed "API-key providers". All edits deep-link out:
- OAuth accounts to Auth Files;
- API keys to the panel below;
- strategy to Config.

**Data flow:** add a per-page, source-scoped `/credentials` read in a new hook, plus one pure, kind-agnostic roster builder. Add no shared cache until a second consumer exists (slice 2).

Server aggregation of the live inventory is **blocked**, not deferred (momus D3): the collector polls every 5 minutes while cooldowns change by the second, and the stored schema has no priority, status or cooldown fields. Only the narrow join ref in slice 3 goes through the history server.

### What each page answers

| Question | Page | Change |
|---|---|---|
| Who serves traffic, in what order, and why not the others? | **AI Providers** | New roster per proxy (this decision) |
| Add, remove, re-auth, disable, set priority, reset cooldown | **Auth Files**, **OAuth** | Deep-link target `?source=&focus=` (slice 2) |
| How much quota is left; 5h/7d windows; burn forecast | **Quota** | Unchanged. Roster rows link here; per-row windows come in slice 3 |
| Is it healthy; how much traffic | **Dashboard** | Unchanged now; reuses the builder in slice 2 |
| Strategy and session-affinity settings | **Config** | Roster header links here |

### Roster layout per proxy section

The strategy and affinity shown are live config: both proxies run `routing.strategy: fill-first` with `session-affinity: true` and a 1h TTL, per explorer (`~/.local/share/cli-proxy-api/config.yaml:2-5`, `~/.local/share/cli-proxy-claude/config.yaml:3-6`). Neither proxy has `api-keys` entries (explorer, from `transformers.ts:367-377` reads against the live config).

*Illustrative mockup: the cooldown reasons and durations are from the live check; plans and counters are placeholders.*

```
codex-primary                       Fill-first · Session affinity 1h · Order as of 17:42  [↻]
 Codex · 2 accounts · 2 ready
   #1  Codex 1   <plan>  prio 100  ● Ready        ← next for new sessions     <ok> / <err>
   #2  Codex 2   <plan>  prio 90   ● Ready                                      <ok> / <err>
   ⓘ Order as of 17:42; priorities may be changed externally. New sessions go to the
     highest-priority ready credential; existing sessions stay on their bound account for up
     to 1h; per-model cooldowns can route a single model elsewhere.
                                                             Manage accounts in Auth Files →
 API-key providers   (existing panel, unchanged)

claude-primary                      Fill-first · Session affinity 1h · Order as of 17:42  [↻]
 Claude · 3 accounts · 1 ready · 2 drained
   #1  Claude 1  <plan>  prio 100  ● Ready        ← next for new sessions
   –   Claude 3  <plan>  prio 90   ◐ Drained · credential quota · back in ~20h
   –   Claude 2  <plan>  prio 100  ◐ Drained · credential quota · back in ~85h
```

**Ordering rule.** Applied within one source and one provider family; the builder mirrors `selector.go` and `scheduler.go`.
1. Ready rows first: priority descending, then `id` ascending by code unit. Ready includes refreshing, partially cooled and unknown-state rows.
2. Then cooling or drained rows, by soonest recovery.
3. Then rows needing attention.
4. Then disabled rows.

Only ready rows get a `#` position.

**"Next" line:**
- The top ready bucket has one member: "Next for new sessions: X".
- It has several members: fill-first shows the order and marks the first; round-robin says "Rotating among N".
- The strategy is unknown: no prediction.
- With session affinity on, the line always reads "for new sessions".

**State chip.** One per row, first match wins:

| State | Rule |
|---|---|
| Disabled | `disabled` or `status = disabled` |
| Needs attention | `unavailable` with `status = error`, and no credential-scope cooldown. Uses `status_message` via `summarizeAuthFileStatusMessage` |
| Drained | Credential-scope cooldown with reason `quota` or `credential_quota` |
| Cooling · reason | Any other credential-scope cooldown |
| Ready · N models cooling | Only model-scope cooldowns |
| Refreshing | `status = refreshing` or `pending` |
| Ready | No blocking condition |
| State unknown | `cooldowns === null` |

Countdowns run from `remaining_seconds`, anchored to when the response was received. At zero they read "elapsed — refresh to confirm" and do not refetch automatically.

**Identity:** the existing `deriveAuthFileIdentity`. It never reads `account`, which can hold a secret.

**Section states:**
- Loading: skeleton rows.
- Load error: an alert with retry, never "0 accounts". On a background error, keep the last good roster with a "stale since" note.
- Valid empty: "No accounts on this proxy", linking to OAuth.
- Config failed: rows still render, with the strategy shown as unknown and no prediction.

**API keys:**
- When config has API keys for the family, they appear in the same roster with an "API key" tag. Their priority comes from config, and is 0 when unset.
- Under the rerank they therefore sit below every OAuth account. That is a true fact the roster will make visible.
- Both proxies have none today, so slice 1 renders only OAuth rows; a builder test covers the merge.

### Data flow

```
proxy :8317 / :8319
  GET /v8/management/credentials ──► createAuthFilesApi(scope.session).list()      (new on providers scope)
  GET /v8/management/config       ──► scope.configStore (existing, 30s TTL + dedupe)  routing.strategy, session-affinity*, api-keys
        │                                   │
        ▼                                   ▼
  useSourceRoster(scope)  (new hook, separate file; obeys the import ban in providerSourceWorkbench.test.ts)
     - fetch on mount, header refresh, AUTH_FILES_CHANGED_EVENT; scope.assertCurrent() after each await
     - keeps {files, observedAt, receivedAtMs, error, previous}
        │
        ▼
  buildSourceRoster({files, apiKeys, routing, receivedAtMs})  (pure, src/domain/providerRouting/roster.ts)
     → { routing, observedAt, families: [{ family, rows: RosterRow[], counts, next }] }
        │
        ▼
  ProviderRosterPanel (per source section, above ProviderSourcePanel)
```

**Rules:**
- No quota adapters or credential downloads are run.
- No POST to `/prox/refresh`.
- Nothing is merged across sources.
- `/observability/usage/queue` is never touched.

**Additions:**
- `providers/RULES.md` records the roster read as an allowed passive read.
- Config normalization gains `routing.session-affinity` and its TTL.

### Slices
0. **Fix (XS, ship alone):**
   - Write a failing test first: `handleStatusToggle` and `handleCooldownReset` in `useAuthFilesData.ts` must fire `notifyAuthFilesChanged`. Then add the calls.
   - This fixes the stale sidebar count today and gives the roster its freshness signal.
1. **Roster (M):**
   - Pure builder with unit tests:
     - ordering and the `id` tie-break;
     - state precedence;
     - drained vs cooling;
     - `null` cooldowns;
     - next-line rules;
     - API-key merge at priority 0;
     - a malformed list is rejected, never shown as empty.
   - Hook, panel, header rename, i18n in all 6 locales, RULES note.
   - `renderToStaticMarkup` tests for each section state, and for two sources with the same file name staying separate.
   - Browser check at 1440 and 390 widths against fixtures, then a live check.
2. **Shared resource (M), when Dashboard and the sidebar adopt the builder:**
   - Registry-lifetime, owner-keyed cache with in-flight dedupe and event invalidation.
   - Auth Files `?source=&focus=` deep link.
   - Dashboard uses the builder's counts.
3. **Quota per row (S–M):**
   - Add a non-secret `authIndex` ref to `PoolAccount` on the history server.
   - Rows then show 5h, 7d and weekly-reset times, and link to the Quota page.
   - The history API is not source-scoped, so filter by `instanceId`.

**Why:**
- The user's complaint from earlier in this session ("providers aren't seeing the stuff proxy has setup") is literally true: the page reads a config tree that is empty on both proxies.
- The gateways archivist checked (sub2api `AccountsView.vue`, new-api's channel table, LiteLLM load balancing, claude-relay-service) all show accounts or channels in a table under a provider grouping, with priority and cooldown state per row. None of the ones checked exposes "who serves next", so any order shown is inferred. Upstream issue router-for-me/Cli-Proxy-API-Management-Center#271, asking for OAuth accounts in priority sorting, was closed without a change.
- The cross-attack showed that freshness comes from fetch time and the change event, not from a cache. The rerank job rewrites priorities every 10 minutes regardless.
- Correctness depends on mirroring the scheduler's bucket rule, and live data proves that showing priority alone misleads: a drained account still sits at 100.

**Survival Score:** Modified.
- vulcan withdrew the shared cache now.
- delphi withdrew the copy-only slice 1 and mandatory merged display.
- vulcan corrected the "next" rule (bucket-size based, new sessions only). delphi did not address it; the Captain adopted it.
- Sorting by state before priority came from vulcan's Phase 2 ordering and the Captain's live check (a drained account still at priority 100). delphi did not address it either.

**Trade-offs accepted:**
- One more independent `/credentials` fetch until slice 2.
- The "next" line is a labelled prediction, not truth.
- No inline edits on AI Providers.
- Per-row 5h/7d waits for a server contract change.

**Second-order consequences:**
- The roster becomes the place where routing surprises show up: drained accounts holding stale priority, and API keys that can never be reached.
- Pressure will grow to edit priority inline. That conflicts with the rerank job, which would overwrite it within 10 minutes.
- Once Dashboard and the sidebar consume the builder, their counts stop drifting from the roster.

**Open risks:**
- The prediction is wrong for bound sessions and for per-model cooldowns. Mitigated by the caption, which states the fetch time, that priorities may be changed externally, and that it applies to new sessions only.
- Countdowns are only as fresh as the last fetch.
- If the rerank job changes its scheme, the UI is unaffected because it reads priorities, not the job.
- **Revisit triggers:**
  - a backend endpoint for affinity bindings appears (then show actual bindings);
  - a second roster consumer lands (then the shared cache);
  - API keys are added to either proxy (then verify the merged render live);
  - the history server gains per-second inventory and the cooldown fields (only then reconsider server aggregation, which momus found blocked).

**Dissent on record:** vulcan's Phase 2 view, that the shared cache belongs in the first slice to stop a fifth duplicate fetch, was conceded rather than refuted; it returns as slice 2.

---
*Appendix*
- **Decision crux:** whether the roster reproduces the scheduler's rule (top ready bucket, `id` tie-break, state before priority, affinity for new sessions only) at a stated time. Caching and page placement are secondary.
- **Context factors:**
  - The proxies are currently split by provider family: :8317 Codex, :8319 Claude.
  - Both proxies have zero API keys.
  - The rerank job owns priority.
- **Missing information:**
  - Whether `success`/`failed` survive a proxy restart, which affects whether row counters are labelled "since restart".
  - Whether the user wants the rerank's reasoning (weekly reset time) on each row, which needs slice 3.
- **Token cost:** about 1M subagent tokens in total (7 Phase 2/3 seats plus Phase 0). Explorer alone used about 310K.

---
Synthesis revised after omo-judge REVISE (1 pass): config sources cited, mockup marked illustrative with live cooldown reasons, prior-art claim narrowed, delphi caption and momus D3 blocker restored, Survival Score attribution corrected.
