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
| M6 | Provider-list editor page | `pages/AuthFilesOAuthExcludedEditPage.tsx` (`initialLoading`, `initialLoadError`, `baselineReady`, `excludedUnsupported`, `saving`, models `loading/error`) | loading, load-error, unsupported, editing, saving | Saving the provider list says nothing about accounts that ignore it (B4). | **Leave** the machine; embed it in the Models screen's Rules tab under a banner naming the accounts that ignore the provider list. | UX: the replace rule is visible where the list is edited. |
| M7 | Alias editor page | `pages/AuthFilesOAuthModelAliasEditPage.tsx` | same shape as M6 | — | **Leave**; embedded in the Aliases tab. | — |
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
- Rules tab: the existing provider-list editor, embedded, under a banner naming the accounts that ignore the provider list.
- Aliases tab: the existing alias editor, embedded.
- Phone: the matrix scrolls horizontally inside its own container with the model column sticky; dialogs are full-width.

**Auth Files** (`#/auth-files`)
- One page header with totals across all sources.
- One filter bar for every source: search, provider chips with counts, status (All / Enabled / Disabled / Problem), source, sort, density.
- Results grouped by source, then by provider. Each source group has a compact header (counts, upload, refresh, refresh credentials, delete filtered) and its own selection bar.
- The two OAuth cards per source are replaced by one "Model access" row per provider, with rule and alias counts and links into the Models screen.
- Old routes redirect: `/auth-files/oauth-excluded?…` → `/auth-files/models?…&tab=rules`, `/auth-files/oauth-model-alias?…` → `/auth-files/models?…&tab=aliases`; `source` and `provider` are kept.

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
