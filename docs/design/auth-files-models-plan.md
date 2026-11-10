# Auth Files rework, a granular Models screen, and the UI data-handling audit

**Headline:** Which models a hub serves is decided by two lists per account, and the account's own list *replaces* the provider list instead of adding to it. Today the UI shows the provider list on one card, hides account lists inside each credential's detail sheet, and has no view of the result. The fix is one pure function from (provider list, account list, disabled flag, reported models) to an effective state per account and model. The Models screen renders that state as a matrix, every bulk toggle becomes a previewed write plan, and the Auth Files page loses its per-source duplication in favour of one filter bar.

**Brief (user's words):** "This page is disjointed and look like shit, please fix it so we're grouping, using unified data and filtering from there"; "a screen that shows us all models for a given provider and allows us to toggle the model across all providers as well as individual accounts. Granular control is requirement"; "Draft up a full plan and fix for the UI data handling", via `/state-machine-audit`.

**Interpretation to confirm:** "across all providers" is read as **across every account of the chosen provider** (the provider-wide toggle). A literal cross-provider toggle, where the same model id is served by several providers (for example a Gemini model through `gemini`, `aistudio`, `vertex` and `antigravity`), is a separate feature, proposed under *Open questions* and not built here.

## 1. Backend rule, verified against the source

The hubs run `localhost/cli-proxy-api:analytics-85eabdce`. The image label `org.opencontainers.image.revision=85eabdce` matches `HEAD` of `~/src/CLIProxyAPI-v8.0.44` (branch `local/ultrafast-v8.0.44`), so that tree is the reference.

| Fact | Where |
|---|---|
| A credential's `excluded_models` attribute holds **only its own rules**; the provider list is never merged into it. | `internal/watcher/synthesizer/helpers.go:54-86` (`ApplyAuthExcludedModelsMeta`) |
| At model registration the provider list `oauth-excluded-models[provider]` is the default, and a **non-empty** own list replaces it. | `sdk/cliproxy/service_models.go:74-82`; same rule in `service_executors.go:630-641` (plugin path) and `antigravity_models.go:670-673` |
| An empty own list, a whitespace-only list or `null` leaves the attribute unset, so the account **inherits** the provider list. | `helpers.go:83-85`; tests `auth_files_excluded_models_test.go:53-58` ("empty clears", "null clears") |
| The provider list does not apply to API-key credentials. | `service_models.go:645-655` |
| Config API keys are not listed as credentials at all (an entry with no file path that is not `runtime_only` is skipped). | `auth_files.go:654-662` |
| `runtime_only` means "held in memory, no file" (for example an AI Studio websocket channel). Such a credential is not API-key kind, so the provider list applies to it; it has no file, so it cannot have a list of its own. | `service_auth.go:376`, `classification.go:30-50` |
| Matching is case-insensitive; `*` matches any run of characters, including none; every other character is literal. | `service_models.go:657-690`, `753-795` |
| Disabled credentials are unregistered and serve nothing. | `service_models.go:47-53` |
| `GET /credentials/models` returns the registry's models for that credential **after** exclusions (and after aliases and prefixes). | `internal/api/handlers/management/auth_files.go:335-380` |
| The credential list entry does **not** include `excluded_models`; it is only in the credential file. | `auth_files.go:649-800` (`buildAuthFileEntryLocked`) |
| `PATCH /credentials/fields` with `excluded_models` (string array or `null`) touches only that field and re-registers the credential. | `auth_files_fields.go:383-453` |

The operational rule in the brief is **confirmed**, with one refinement: giving an account an *empty* list does not stop inheritance. An account therefore cannot serve a model the provider list excludes unless it has a non-empty list of its own that does not exclude that model.

The rule lives in one constant and one function, `ACCOUNT_LIST_POLICY` and `rulesInEffect()` in `src/features/authFiles/modelAccess/accessRule.ts`, with one table-driven test (`tests/modelAccessRule.test.ts`).

## 2. State-machine audit

Baseline before any change (`eebab95d`): `bun run test` 2266 pass / 0 fail across 211 files; `bun run type-check` clean; `bun run lint` 0 errors, 6 warnings (react-refresh).

| # | Machine | Files | States (implicit ones in italics) | Invalid or confusing today | Decision | UX / DX / AX effect |
|---|---|---|---|---|---|---|
| M1 | Credential list load | `hooks/useAuthFilesData.ts` (`loading`, `refreshing`, `error`, `files`) | idle, loading, ready, refreshing, error, *error with stale files* | `error` set with old files still on screen is intentional but unnamed. | **Document**: name the derived state in `listLoadState()` (pure), add `data-machine="auth-files-list" data-state` on each source group. | UX unchanged; DX one derivation instead of four booleans read ad hoc; AX state readable from the DOM. |
| M2 | Per-file pending operations | same hook: `statusUpdating`, `manualRefreshing`, `cooldownResetting`, `deleting`, `deletingAll`, `uploading`, `batchStatusUpdating`, `refreshingAllCredentials`, each mirrored by a ref | per key: idle, pending | Ref and state pairs are already guarded against double submit and source switches; covered by `authFileStatusIdentity`, `authFileRefreshActions`, `authFileRefreshAll` tests. | **Leave**. Risk outweighs gain; bug B1 reported. | — |
| M3 | OAuth config load (provider lists and aliases) | `hooks/useAuthFilesOauth.tsx` (`OAuthConfigLoadError = 'loading' \| 'load' \| 'unsupported' \| null` plus `excludedReadyRef`) | loading, ready, error, unsupported, *reloading with stale data* | `null` means "ready" inside a type called *Error*; the ready ref duplicates it. | **Document** on the type; the Auth Files summary exposes it as `data-machine="oauth-config" data-state`. No behaviour change. | DX/AX: state named and visible; UX unchanged. |
| M4 | Per-account model list modal | `hooks/useAuthFilesModels.ts` | closed, loading, ready, unsupported, *cached* | Bug B2: the modal marks a model "Disabled" using only the provider list. | **Leave** the machine; report B2. The Models screen supersedes the modal's purpose. | — |
| M5 | Credential detail editor (includes the account's excluded list) | `hooks/useAuthFilesPrefixProxyEditor.ts` (`loading`, `saving`, `error`, `json`, many `*Touched`) | closed, loading, load-error, editing, saving | Saving does not re-read the file first, so a concurrent change made in the Models screen is silently overwritten (B3). | **Leave**; report B3. A rewrite touches 800 lines and 5 test files. | — |
| M6 | Provider-list editor page (removed) | `pages/AuthFilesOAuthExcludedEditPage.tsx` (`initialLoading`, `initialLoadError`, `baselineReady`, `excludedUnsupported`, `saving`, models `loading/error`) | loading, load-error, unsupported, editing, saving | Saving the provider list says nothing about accounts that ignore it (B4). | **Replaced** by the Rules tab, which edits any list through the edit session (M11): preview, stale check, partial-failure handling, and a banner naming the accounts that ignore the provider list. The route redirects there. | UX: the replace rule is visible where the list is edited; DX: one write path instead of two. |
| M7 | Alias editor page | `pages/AuthFilesOAuthModelAliasEditPage.tsx` | same shape as M6 | — | **Leave**; keeps its own route, reached from the Aliases tab. Embedding was rejected: its global Escape-to-go-back handler would fight the Models dialogs. | — |
| M8 | Account excluded-models field | `components/AuthFileExcludedModelsField.tsx` (`loading`, `loadFailed`) | loading, error, ready | Already collapsed to `ExcludedModelsCatalogState`. | **Already explicit** (union `ready \| loading \| unavailable \| error`). | — |
| M9 | Excluded-models picker | `components/excludedModels/ExcludedModelsPicker.tsx` (`open`, `reservedHit`) | closed, open | — | **Leave** (UI-local). | — |
| M10 | **Model inventory load** (new) | `modelAccess/inventoryState.ts`, `hooks/useModelAccessInventory.ts` | idle, loading, ready, error; per account: own list known/unknown, reported known/unknown | New code; replaces three separate fetch paths (M3 provider list, M4 per-account models, M5 account list). | **Model**: discriminated union, one reducer, transition table, request generation guard, `data-machine="model-inventory"`. | UX: one loading/error state per provider instead of three; DX/AX: table next to the code. |
| M11 | **Model edit session** (new) | `modelAccess/editSession.ts` | idle, choosing, previewing, saving, saved, partial-failure, failed, stale, rolling-back | New code. | **Model**: union, one transition function, `InvalidTransitionError(machine, from, event)`, `data-machine="model-edit-session"`. | UX: preview before every write, no silent partial success; DX/AX as above. |

Already explicit and left alone: the credential inventory store (`stores/useCredentialInventoryStore.ts`, documented single `set()` commit and version poll), the source scope lifetime (`sourceScope.ts`), `ExcludedModelsCatalogState`.

### Bugs found (reported, not silently fixed)

- **B1** `useAuthFilesData.batchSetStatus` has no `catch`. When the source changes during the batch, `sourceScope.assertCurrent()` throws out of an `onClick` handler as an unhandled rejection (`useAuthFilesData.ts:870`). Valid-path behaviour is unaffected.
- **B2** `AuthFileModelsModal` marks a model "Disabled" when the *provider* list matches it (`constants.ts:301`, `AuthFileModelsModal.tsx:64`). The models come from `/credentials/models`, which is already post-exclusion, so the badge can only fire for an account with its own list, which is exactly the account the provider list does not apply to. It is wrong in every case where it fires.
- **B3** The credential detail sheet writes `excluded_models` without re-reading the file, so it can overwrite a list changed elsewhere since the sheet opened.
- **B4** The provider-list editor gives no hint that accounts with their own list ignore it. This is the UI half of today's incident.
- **B5** The Auth Files "OAuth Model Disablement" card says "claude · 2 models disabled" while an account with its own list serves one of those models. Fixed by design: the card is replaced by the Models screen.
- **B6 (retracted)** I reported that the credential sheet's legacy `excluded-models` key was ignored by the backend. It is not: the patch handler canonicalizes request keys (`auth_files_fields.go:483-505`) and the backend's own test "alias override" proves the legacy key is applied. No change was needed or made.

## 3. Unified data model

One inventory per (source, provider), loaded once by `useModelAccessInventory` and shared by every cell:

```
ModelAccessInventory
  provider        normalized provider key
  providerList    string[]                     GET /config/oauth/excluded-models
  catalog         string[]                     GET /routing/model-definitions/:provider
  aliases         OAuthModelAliasEntry[]       GET /config/oauth/model-alias
  accounts[]      AccountAccess
    name, label, disabled                      credential inventory store (no extra list call)
    ownList       { status: 'known', rules: string[] | null, field } | { status: 'unknown' }
                                               file download, parsed in the API layer, only the list kept
    reported      { status: 'known', ids: string[] } | { status: 'unknown' }
                                               GET /credentials/models
  models          catalog ∪ every reported id ∪ every exact rule
```

`resolveCell(providerList, account, modelId)` is pure and returns exactly one of:

| Kind | Meaning | Toggle |
|---|---|---|
| `served` | No rule in effect matches and the account reports the model. Carries `via: 'provider' \| 'account' \| 'none'`. | yes |
| `excluded-own` | A rule in the account's own list matches. Carries the rule. | yes, unless the rule is a wildcard |
| `excluded-provider` | The account inherits, and a provider rule matches. Carries the rule. | yes (asks provider-or-own), unless wildcard |
| `wildcard` | The matching rule contains `*` (from either list). Shows the rule and links to edit it. | **no** |
| `disabled` | The account is disabled. | no |
| `no-access` | No rule matches, but the account does not report the model (plan or registry). | no |
| `unknown` | The account's own list or model list could not be read. | no |

`drift: true` marks a cell whose rules say excluded while the account still reports the model, or the reverse. This happens right after a write, while the hub re-registers asynchronously.

Row summary: `servedBy` (the accounts serving the model) drives the "served only through one account" warning.

## 4. Write plans

The user picks an intent; `buildWritePlan(inventory, intent)` turns it into the exact list writes. Nothing is written before the preview is accepted.

| Intent | Writes |
|---|---|
| (a) one model, one account with **its own list** | that account's list ± the model. Removing the last entry would make the account inherit again, so the plan shows a notice and keeps the effect visible in the preview. |
| (a) one model, one **inheriting** account, `mode: 'provider'` | the provider list ± the model (affects every inheriting account; the preview lists them) |
| (a) one model, one **inheriting** account, `mode: 'own'` | a new own list for the account = provider list ± the model. The account stops following the provider list; the preview says so. |
| (b) one model across every account of the provider | the provider list **and** every account that has its own list ± the model (replace rule). Lists whose wildcard rules still match are reported as `blocked` with the rule. |
| (c) one account across every model | exclude: own list = every known model id. Include: own list cleared (inherit), and the preview shows what the provider list still excludes. |
| (d) provider default for one model | the provider list only; the preview names the accounts with their own list that will **not** follow it. |
| replace a list (Rules tab) | the chosen list replaced as edited. |

A plan holds `writes[]` (target, `before`, `after`), `blocked[]`, `notices[]` and `changes[]`: every cell whose effective state differs between the current and planned lists, computed with the same `resolveCell`.

### Executing a plan

`executeWritePlan(plan, io)` with `io` = { read provider list, read account list, write provider list, write account list }:

1. **Stale check.** Re-read every target. If any differs from the `before` the preview was built on, write nothing and return `stale` with the differences.
2. **Writes.** Own lists first, provider list last, one at a time. For a "disable everywhere" this never widens what is served mid-plan.
3. **Result.** Per write `ok` or `failed(message)`; overall `saved`, `partial-failure` or `failed`.
4. **Retry** re-runs only the failed writes, after a fresh stale check. **Rollback** writes `before` back to every write that succeeded, guarded by a check that each target still equals its `after`.

**API gap:** there is no atomic multi-list write. The UI is safe without one: the stale check runs right before writing, the write order fails closed, and partial results are always shown with retry and rollback.

## 5. Edit session state machine

```
idle ──START(intent)──▶ choosing ──CHOOSE(mode)──▶ previewing
idle ──START(intent)──────────────────────────────▶ previewing      (no choice needed)
choosing / previewing ──CANCEL──▶ idle
previewing ──APPLY──▶ saving
saving ──DONE(all ok)──▶ saved           ──DISMISS──▶ idle
saving ──DONE(some ok)─▶ partial-failure ──RETRY──▶ saving | ──ROLLBACK──▶ rolling-back | ──DISMISS──▶ idle
saving ──DONE(none ok)─▶ failed          ──RETRY──▶ saving | ──DISMISS──▶ idle
saving ──STALE(diffs)──▶ stale           ──REPLAN(plan)──▶ previewing | ──CANCEL──▶ idle
rolling-back ──DONE──▶ saved | partial-failure
```

Any other (state, event) pair throws `InvalidTransitionError` naming the machine, the state and the event. After `saved` and `partial-failure` the inventory is re-read and the matrix shows the resulting effective state.

## 6. Screens

**Models** (`#/auth-files/models?source=<id>&provider=<key>&tab=access|rules|aliases`)
- Header: source switcher (the existing management-source toolbar), provider picker (every provider with credentials or rules on that source), Refresh.
- Filter bar: search over models and accounts, view switch All / Served / Excluded, counts.
- Access tab: matrix. Rows are models; columns are the provider list, then each account (label, inherits/own-list badge, column menu), then "Served by". Each cell is a button with an accessible name stating model, account, state and reason; `data-cell` and `data-state` attributes. Row menu: disable/enable everywhere, provider default. Single-account warning icon on the row.
- Dialogs: inherit choice (edit provider list vs give this account its own list), preview (writes, blocked, notices, cell changes), result (saved, partial failure with retry/rollback, stale with re-preview).
- Rules tab: pick a list (the provider list or any account's own list) and edit it with the existing `ExcludedModelsPicker`, wildcards included. Saving opens the same preview and edit session as a toggle. A banner names the accounts that ignore the provider list.
- Aliases tab: the existing alias card (list and diagram, inline edits), moved off the Auth Files page; full edits open the alias editor at its own route.
- Phone: the matrix scrolls horizontally inside its own container with the model column sticky; dialogs are full-width.

**Auth Files** (`#/auth-files`)
- One page header with totals across all sources.
- One filter bar for every source: search, provider chips with counts, status (All / Enabled / Disabled / Problem), source, sort, density.
- Results grouped by source, then by provider. Each source group has a compact header (counts, upload, refresh, refresh credentials, delete filtered) and its own selection bar.
- The two OAuth cards per source are replaced by one "Model access" row per provider, with rule and alias counts and links into the Models screen.
- Old routes: `/auth-files/oauth-excluded?…` redirects to `/auth-files/models?…&tab=rules`, keeping `source` and `provider` (and navigation state). `/auth-files/oauth-model-alias?…` still opens the alias editor unchanged.

## 7. Tests

- `modelAccessRule.test.ts`: the replace rule table (no list, empty list, whitespace list, own list, API-key kind), wildcard semantics (`*` anywhere, literal dots, case).
- `modelAccessResolve.test.ts`: every cell kind, wildcard lock from either list, drift, single-account warning, model union.
- `modelAccessWritePlan.test.ts`: every intent; inherit choice is required (no implicit own list); disable-everywhere writes the provider list and every own list; blocked wildcards; last-entry notice; no-op plans.
- `modelAccessExecute.test.ts`: stale abort with no writes, write order, partial failure, retry of failed writes only, rollback guarded by `after`.
- `modelEditSession.test.ts`: the full transition table, every invalid pair throws with machine, state and event.
- `modelAccessApi.test.ts`: reading an account list from a credential file keeps only the list and its field name; writing uses the field the file already uses.
- `authFilesListState.test.ts`: characterization of M1's derived state.
- Source contracts: routes and redirects, i18n keys in all six locales.
- Browser: `scripts/visual/auth-files-capture.sh build …`, every state at 1440 and 390 against the production build: loading, empty, error, served-only/excluded-only, wildcard locked, inherit choice, own-list toggle, preview, saved, partial failure, stale.

## 8. Gaps and open questions

- **API gap G1:** the credential list does not expose `excluded_models`. The Models screen downloads each credential file of the chosen provider, and the API layer parses it and returns only the list. The rest of the file is discarded immediately and never stored, logged or rendered. A backend field on the list entry would remove these downloads.
- **API gap G2:** no atomic multi-list write (see §4).
- **API gap G3:** `/credentials/models` is post-exclusion, so for an excluded model the UI cannot tell whether the account's plan includes it.
- **Behaviour gap G4:** an account cannot serve a model the provider list excludes unless it has a non-empty own list (see §1).
- **Open question Q1:** a literal cross-provider toggle ("disable `gemini-3-pro` on every provider that serves it, on every hub") is feasible as a second view over the same inventory, built per (source, provider) and grouped by model id. Confirm before it is built.
- **Open question Q2:** aliases are matched after exclusions, so an excluded upstream model also removes its alias. The matrix shows alias chips on the upstream row only.

## 9. Built and verified

Branch `feat/auth-files-models`; every behaviour below runs against the synthetic hubs in `scripts/visual/fake_hub.py`, never a real hub.

- Pure core (`src/features/authFiles/modelAccess/`): the rule, resolver, write plans, executor and both machines; 7 test files, about 230 tests.
- Models screen (`src/features/authFiles/models/`, route `#/auth-files/models`), Auth Files page rework, API reader and writer for account lists.
- Found and fixed during browser verification, before commit: a Sass selector that broke the build; a race where the Models inventory read the credential store before its runtime started (zero accounts shown); a refresh loop that the first fix for that race introduced on a failing source (now bounded: eight credential reads in the error case); StrictMode leaving the error case stuck in `loading`; focus not returned to the cell after a dialog closed.
- Commands: `bun run verify` passes (tests, lint with 0 errors and the same 6 warnings as before, single-file build). Browser: `scripts/visual/auth-files-capture.sh build docs/evidence/auth-files-models/after` against `vite preview` of the production build, and `…capture.sh url=http://127.0.0.1:18399 docs/evidence/auth-files-models/container` against the production nginx image built from `deploy/Dockerfile` (listen lines changed only). `scripts/visual/models-keyboard-check.py` checks focus in and out of dialogs, roving tabs, accessible names, wildcard cells never writing, and reduced motion.

## 10. One model-access store for every screen (second pass)

The first pass left six private copies of the same data: the Auth Files hook (provider lists, aliases, catalogs), the Models hook, the per-account models dialog and its cache, the credential sheet's exclusion field, the alias editor, and the alias card. They could disagree, and bug B2 was one such disagreement.

**Now:** `src/stores/useModelAccessStore.ts` holds, per source, five kinds of slice: provider lists, aliases, catalogs per provider, own list per credential, reported models per credential. Each slice is one `LoadState` (`modelAccess/loadState.ts`, which replaces the Models-only inventory machine M10): a newer request supersedes an older one, a failed re-read keeps the last data, a replaced session's data is dropped. `ensure*` loads what is missing or older than 30 s; `{ force: true }` re-reads (Refresh, and after every write). Nothing is patched optimistically.

| Screen | Before | Now |
|---|---|---|
| Models matrix, Rules tab | own fetch of everything | derives from the store (`deriveInventoryLoad`, `buildInventory`) |
| Auth Files model-access row, alias card | `useAuthFilesOauth` state and request counters | the store's provider-list and alias slices |
| Per-account models dialog | own fetch and cache; "Disabled" badge guessed from the provider list (B2) | the store; each model resolved by `resolveCell` with its list or rule |
| Credential sheet exclusion field | own fetch of the already-filtered model list | catalog and reported models from the store, plus a line saying whether this account follows or replaces the provider list |
| Alias editor | own fetch of lists, aliases and catalog | loads through the store; keeps a snapshot baseline so a background refresh cannot reset a draft |

A contract test (`tests/modelAccessStore.test.ts`) fails if any file other than the store runtime calls the raw reads.

**Bug fixes in this pass:** B1 (batch enable/disable now has a catch), B2 (the dialog, above), B3 (the credential sheet re-reads the account's list before saving and refuses if it changed since the sheet opened). B4 and B5 were fixed by design in the first pass. B6 is retracted.

**New in the model (corrected in section 11):** `runtime_only` credentials of the provider are accounts of kind `runtime`, shown as read-only columns. This pass described them as config API keys that the provider list never reaches. That was wrong; see section 11.

**Not unified, and why:** the Dashboard and System pages read the hub's public `/v1/models` list through the per-source `modelsStore`; that is a different dataset (what an API key sees) and already has one store. AI Providers edits API-key provider entries through the config store and its own resource model (`providers/adapters.ts`); those entries are shown here read-only rather than edited through a second path.

## 11. Review pass: making the screens agree (third pass)

Three independent reviews (screens at 1440 and 390 px, cross-screen data, and the branch diff) produced about 55 findings. What changed:

**A fact corrected.** Section 10 treated `runtime_only` credentials as config API keys outside the provider list's reach. The backend says otherwise (rows added to the table in section 1): a `runtime_only` credential is held in memory with no file, follows the provider list, and cannot have a list of its own; config API keys never appear in the credential list. So `resolveCell` no longer special-cases `runtime`, the `not-served` cell kind and the `still-served-by` notice are gone, "Exclude everywhere" counts runtime credentials among the accounts the provider list reaches, and the Models screen carries a one-line note that API keys from AI Providers are not listed and are not covered by exclusion lists. The card label is "Runtime only".

**Write safety** (`editSession.ts`, `execute.ts`, `writePlan.ts`, `useModelEditSession.ts`):

- A session now knows whether it is applying or rolling back. A rollback that fails stays a rollback: Retry re-runs the undo, never the forward write (this was the high-severity finding: Retry after a failed rollback completed the change the user was undoing).
- `stale` and `failed` keep the outcomes of earlier writes, and the dialog says what is on the hub. "Nothing was written" appears only when that is true. A completed rollback always ends in `rolled-back`; a stale rollback cannot be re-planned as the forward change.
- A plan carries `guards`: lists it depends on but does not write (every other file account's own list for provider-wide plans; the provider list when a plan relied on it). A guard that changed since the preview is `stale` with nothing written.
- Each target is re-read immediately before it is written. Without an atomic backend endpoint a one-request window remains; guards are checked once, before the first write.
- "Exclude all" keeps the rules already in effect (wildcards included) and adds only what they do not block; when everything is already blocked the plan is a no-change.
- After a write only the provider lists, the written accounts and the accounts whose rules in effect changed are re-read. A failed re-read no longer turns a saved write into an error; the dialog offers "Read again".

Transition table as built (`'self'` = the state keeps its name with new data; RERUN = `REFRESH`/`REFRESHED` for the table re-read):

```
idle            START -> choosing | previewing
choosing        CHOOSE -> previewing          CANCEL -> idle
previewing      APPLY -> saving               CANCEL -> idle
saving          SETTLED -> saved | partial-failure | failed | stale     ERROR -> failed | partial-failure
saved           DISMISS -> idle               RERUN
partial-failure RETRY -> saving | rolling-back    ROLLBACK -> rolling-back    DISMISS -> idle    RERUN
failed          RETRY -> saving | rolling-back    DISMISS -> idle             RERUN
stale           REPLAN -> previewing (apply only) CANCEL -> idle              RERUN
rolling-back    SETTLED -> rolled-back | partial-failure | failed | stale   ERROR -> failed | partial-failure
rolled-back     DISMISS -> idle               RERUN
```

**One definition per fact.** `credentialFacts.ts` defines a credential's provider (`providerOfCredential`), whether a provider key is a real name (`isNamedProvider`) and its health (`credentialHealth`: exactly one of active, problem, disabled; `countCredentials`). The Auth Files header, groups and status chips, the Dashboard, the Models provider list and the Quota "family" (`resolveAuthProvider` = the shared key plus `kimi-ai` to `kimi` for the shared quota API) all use it. Enable/disable, batch enable/disable and cooldown reset now publish to the shared credential inventory, so the header, Models and Dashboard change with the card. Quota no longer offers a quota card for a runtime-only credential.

**One editor per thing.** An account's exclusion list is edited on the Models screen only (cells or the Rules tab, both with preview, stale check and rollback). The credential sheet shows a read-only summary with a link; its save never sends `excluded_models`, so the B3 stale check and `staleCheck.ts` are gone. The Models screen is reached from the sidebar, from each provider heading on Auth Files ("Models") and from the per-account "Served models" dialog; the source-level button and the bottom summary panel are removed.

**Screens.** Models: sticky model and provider-list columns, fixed-width account columns with an overflow cue, rows of about 44 px, a legend above the table, a per-account list under 600 px, the same source pills as Auth Files, the top-bar refresh, no ghost provider chip after switching hub, normalised `?provider=`. Auth Files: truthful loading and unreachable states with retry, counts that add up, "Delete N shown" deletes exactly the cards shown (it used to ignore the search box), group actions in one row with an overflow menu, one page-level empty state, an "Other" group for credentials without a usable type. Alias editor: same header pattern as Models, provider fixed when given.

**Left alone, reported.** One quota store shared by Auth Files and the Quota page (today each page keeps its own, so a quota refreshed on one does not show on the other): it contradicts `src/features/quota/RULES.md` ("each source section owns a separate quota store") and a disposal test, so it needs a decision. One shared "selected hub" across pages (Auth Files filters, Dashboard pills and the `?source=` pages each keep their own). `src/services/api/kimiQuota.ts:72` parses runtime-only itself.

## 12. Layout as the owner specified it (fourth pass)

The owner's spec, verbatim: "grouped lists on the left hand side, with models across the top bar. Table should be just for one provider. Tabs per provider to switch to different model table", "single refresh quota button for all auth cards", and "the same smaller component is always in the same spot on a larger component. If a bar is missing then it needs to be filled in with a default state that takes up the space".

**Models.** The table is transposed: one column per model, and a sticky left column with grouped rows: Provider (the provider list row, the default), Follows the provider list, Own list, List unreadable, Off. One provider at a time, chosen with the same provider tabs Auth Files uses; the hub pills are a filter with "All sources", and each hub that has the provider gets its own section with its own inventory and edit session (`ModelsHubSection.tsx`). `?source=` is optional. Every cell is a chip of one size; loading, empty and error blocks take the table's frame. Under 600 px it stays a per-account list. The core (`buildMatrix`, write plans, edit session) is unchanged; the transposition is in the view (`matrixView.ts`).

**Auth Files.** One "Refresh quota" button in the filter bar loads quota for every card shown, through the Quota page's batch loader (`useQuotaBatchLoader`, now with an optional per-target callback for progress). Every card has the same slots at the same heights: header, identity line, requests, meta line, quota slot, action row, status row. A slot without data shows a default state of the same size (`quotaSlot.ts` picks among not loaded, loading, loaded, failed, and "no quota for this credential"); an action that does not apply is disabled, not removed. Skeleton cards, group empty and error blocks, and header counts follow the same rule.
