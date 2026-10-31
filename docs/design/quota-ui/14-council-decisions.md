# Council decisions: the four open questions (2026-10-31)

**Headline:** on three of the four questions, the evidence said to restyle what is on screen rather than hide it. 26 reviewer notes on the toolbar settings asked for labels inside the selects or one label row, against 4 for a popover. No note asked to remove the Ready chip.

**Brief:** adopt, adopt with changes or reject each of four open spec decisions, then implement the agreed ones in phase order.

**Phase 0 reframe (omo-sophia, per the council skill's Lean+ pre-phase):** which changes raise screen×aspect medians toward 9.0 without burying status, data or errors, and what is the smallest version of each new behaviour worth shipping? The user's "implement the ones that are agreed upon" lifts the hill-climb's no-new-behaviour default for agreed items only.

**Variant:** Lean+. The seats were vulcan, delphi, archivist, explorer and momus. Phase 3 ran with vulcan and delphi on decisions 2, 3, 4a, 4b and 4d. Decisions 1 and 4c weren't cross-attacked, because both proposers agreed in Phase 2 and momus raised no objection.

## Evidence used

### Reviewer notes

The corpus is `/tmp/hc/notes_all.json`: 6,242 notes from r10 to r27, extracted from the raw reviewer JSON by `/tmp/hc/extract_notes.py`. It is local and not committed.

| Topic | Notes | What they said |
|---|---|---|
| "Forecast: Ready" chip | 35 | None ask to remove it. They complain the badge shapes don't match and the green dot is the only green on the page. |
| Toolbar settings | 26 | Labels inside the selects, or one label row. All four lenses, through r27. |
| Toolbar settings | 4 | A popover or settings menu. Last seen in r24. |
| Shell icon box | 52 | "Bordered box floats above the title row." |
| Sort | 2 | "'Default order' doesn't say what the order is." Two lenses, r27. |
| Affected accounts | — | "Link the count to the affected rows" (r10, r11, r14). Masked names wrap inside notices on phones (r23–r27). |
| URL state | 0 | — |
| Table view | 0 | — |

### Code

| Fact | Where |
|---|---|
| Server order is `a.id.localeCompare(b.id)` | `server/quota/domain.ts:244` |
| Ids are sha256-based | `server/quota/identity.ts:6` |
| Data reloads every 15s | `src/features/quotaPool/poolResource.ts:112` |
| A collector refresh runs every 60s | `poolResource.ts:116-120` |
| Roster controls render only above 8 accounts | `src/features/quotaPool/PoolCard.tsx:21, 85` |
| `lowestPercent` returns `Infinity` for accounts with no data, so they sink to the bottom under "lowest" | `PoolCard.tsx:105-111` |
| Open rows are kept by account id, so they survive a reorder | `PoolCard.tsx:49, 451, 454` |
| The `.header-actions` box rule is shared with `.mobile-sidebar-actions` on every page | `src/styles/layout.scss:148-170` |
| On phones, the two selects already share one full-width row; a label line sits above them, plus a hint line in Drain and Burn | `src/features/quotaPool/QuotaPoolPage.module.scss:1373-1385` |

The capture harness, `scripts/visual/prox-quota-capture.py`:
- uses the combobox "Rate interval" by name (around line 895);
- asserts 5 `article details` in the ready case (around line 813);
- checks the shell box doesn't overlap the countdown (around lines 846-851).

### External sources (archivist)

| Claim | Sources |
|---|---|
| Show status only on exceptions | [Carbon status indicators](https://carbondesignsystem.com/patterns/status-indicator-pattern/), [Atlassian lozenge](https://atlassian.design/components/lozenge/usage), [Cloudscape loading and refreshing](https://cloudscape.design/patterns/general/loading-and-refreshing/) |
| Affirm normal state | [Statuspage "Operational"](https://support.atlassian.com/statuspage/docs/top-level-status-and-incident-impact-calculations/) |
| Settings that change what data means sit inline at the top | [Grafana variables](https://grafana.com/docs/grafana/latest/dashboards/variables/) |
| Don't hide what most users need | [GOV.UK details](https://design-system.service.gov.uk/components/details/) |
| URL state | [GitHub filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests), [Cloudscape filter persistence](https://cloudscape.design/patterns/general/filter-patterns/filter-persistence-in-collection-views/) |
| Table view | [Carbon Charts toolbar](https://github.com/carbon-design-system/carbon-charts/blob/4baa87bb1b5aba5e1a16b3a7bd8cf9c548afd894/packages/core/src/components/axes/toolbar.ts#L585-L595), [W3C complex images](https://www.w3.org/WAI/tutorials/images/complex/) |
| A filter action on a failure notice | Cloudscape loading and refreshing (above) |

## Decisions

### 1. Hide the status chip when ready: rejected

We keep a quiet chip instead.

- **What ships:**
  - The chip shows in every state, with one pill shape and a word plus an icon.
  - "Forecast: Ready" goes neutral: secondary text, a check icon, no green.
  - Every other state keeps its tone and has its own icon: Partial ◐, Stale ◷, Saved (history), Collecting (spinner-free dots), No accounts ⓘ and No limit ⓘ.
  - This reverses the locked "Ready status" row in `12`.
- **Why:**
  - The 35 notes are the kind of measurement the decision log says can reopen a locked choice.
  - R§3 in `13-research.md` is Primer's guidance on success *messages*, not persistent status chips.
  - The chip wraps inside `.poolMeta` (`QuotaPoolPage.module.scss:357`), so an empty reserved slot is invisible and hiding the chip gains nothing.
  - A neutral Ready closes both complaints reviewers raised about the chip: shape and lone green.

### 2. Chart options popover: rejected

Inline labels stay instead.

- **What ships:**
  - Rate interval and Future usage stay inline as native selects.
  - Each box shows a visible prefix ("Rate 3h", "Future Same as now"). The prefix is an `aria-hidden` span; the `<label>` stays as the accessible name, visually hidden.
  - When Future usage is disabled, "Applies to Remaining view" stays visible on the same row, linked by `aria-describedby`.
  - The toolbar has one label baseline.
- **Fallback:** if the phone toolbar measures over its budget, use a popover whose trigger shows the values.
- **Why:**
  - These two settings change every card's numbers. Future usage is shown nowhere else, so hiding it buries meaning. Archivist's Grafana and GOV.UK evidence points the same way.
  - On phones the selects already share one row (code table above). A popover trigger with values would take that same row, so the popover saves no rows. It only removes the label and hint lines, which inline prefixes also remove.
  - Native selects keep the capture's "Rate interval" locator working.
  - A `title` tooltip is unreliable on disabled controls and on touch, so the reason stays as visible text.

### 3. Keep the shell cluster out of scope: rejected

The box gets restyled instead.

- **What ships:**
  - Split `.header-actions` from the shared rule with `.mobile-sidebar-actions`.
  - Drop the border and outer shadow on `.header-actions` only, including its overrides. The mobile sidebar box is unchanged.
  - Keep the translucent background and blur, because content scrolls under the fixed header.
  - No re-alignment to the title row, because it risks the countdown overlap. That goes to a shell ticket.
  - Capture two other pages before and after.
- **Why:**
  - Refresh behaviour is already shared through `useHeaderRefresh`.
  - The 52-note complaint is about the box, not the buttons.
  - Restyling the box in the shared stylesheet changes it on every page at once, which keeps the shell consistent. That was archivist's concern.
  - Limiting the change to `.header-actions` keeps it to the element reviewers saw.

### 4a. URL view state: adopted with changes

It ships last and is first to cut.

- **What ships:**
  - Keys: `provider`, `window`, `mode`, `lookback`, `future`.
  - The parsing allow-lists and `replace: true` writes come from `src/features/analytics/AnalyticsPage.tsx:78-115`.
  - **New, unlike Analytics:** keys left at their default value are omitted from the URL.
  - No `offset`: it's relative to today, so a shared link would drift.
  - Never `reveal`, for privacy.
  - Per-card sort and filters stay in component state.
- **Why:** low risk, and the codebase already has the pattern. Screenshot reviewers can't score it, so it ships after the visual work.

### 4b. "Lowest limit first" as the default sort: rejected

"Name A–Z" becomes the default instead.

- **What ships:**
  - The default is "Name A–Z": `Intl.Collator` with numeric ordering, on the displayed account name, with the id as tie-break.
  - "Lowest limit first" stays as the second option. It's fixed so that accounts with no data come first, then lowest percent, then name.
  - The compact baseline is regenerated.
- **Why:**
  - The data reloads every 15s and refreshes every 60s, so a value-based default can move rows while someone reads them or has keyboard focus in them. Open rows survive the move, because they're keyed by id; their position doesn't.
  - Rosters of 8 or fewer accounts would reorder with no visible sort label.
  - Today's "Default order" is sha256 order, so neither it nor "Order added" is honest. "Name A–Z" is honest and answers the r27 note.
  - Decision 4c takes over the job of surfacing affected accounts.
- **Known cost:** toggling "Show emails" changes the displayed names, so rows reorder when it flips.

### 4c. "Show affected accounts": adopted with changes

These mechanics are vulcan's Phase 2 proposal. They weren't cross-attacked.

- **What ships, on provider cards only:**
  - The notice states a count instead of listing masked names, and offers the action.
  - The action turns on an "Affected (N)" toggle chip, using the same pattern as the low chip.
  - It also resets paging, scrolls to the accounts list and focuses the first affected row.
  - While the filter is on, the chip row renders even for rosters of 8 or fewer.
- **Combined card:** keeps its count text per provider, with no action.
- **Why:**
  - It replaces the wrapping name lists.
  - It gives the notice an action that isn't a second refresh.
  - Cloudscape has direct precedent for a filter action on a failure notice.

### 4d. Chart "View as table": rejected for now

It moves to "Beyond this redesign".

- **What ships:** nothing new. The focusable figure and summary sentence from `07` stay.
- **If adopted later:** use a toggle button, not `<details>`, and reuse the `analytics.table_alternative` copy.
- **Why:**
  - It has 0 notes.
  - Reusing `<details>` breaks the capture invariant of 5 `article details`.
  - A toggle button would add a second pattern for the same job in the middle of a hill-climb.

## Survival Score

**Modified.**

In Phase 3, vulcan withdrew the popover in favour of inline labels and limited the shell restyle to `.header-actions`. Delphi dropped re-alignment from the shell restyle, moved 4a from defer to "adopt last" without `offset`, and withdrew lowest-first in favour of Name A–Z once it confirmed sha256 order and the 15s reload.

On 4b the two proposers crossed positions. The Captain chose Name A–Z because its reasons were verified in code: the reload cadence, the sort control hidden at 8 or fewer accounts, and sha256 order. Vulcan's tie-break limits how far rows move but doesn't stop them moving.

Decisions 1 and 4c rest on Phase 2 agreement only.

## Trade-offs accepted

- The Ready chip stays on screen.
- The toolbar keeps five control groups; only their weight and baseline change.
- No deep links to a date offset.
- No data table for the chart this pass.
- Rows reorder when "Show emails" is toggled.

## Open risks and what reopens a decision

| If this happens | Then |
|---|---|
| Two lenses call the Ready chip clutter | Hide it. |
| Two lenses still cite "five equal-weight groups" | Give the settings group ghost styling. |
| The phone toolbar measures over budget | Use the popover with the values in its trigger. |
| The a11y lens asks for a chart data alternative two rounds running | Build the table view. |
| The shell restyle reads poorly over scrolled content on any page | Revert it. |

## Dissent on record

- **Archivist**, on the chip: hide the Ready chip, provided absence unambiguously means ready and a timestamp cue is added.
- **Archivist**, on the table view: adopt "View as table" now, as a visible control.
- **Archivist**, on the shell: leave it untouched and file a separate shell ticket.
- **Archivist and vulcan**, on sorting:
  - Archivist (Phase 2): adopt "Lowest limit first" with changes.
  - Vulcan (Phase 3): make it the default, with no-data accounts first and a name tie-break, accepting re-sorts on refresh.
- **4 reviewer notes** (r16–r24) asked for the settings to go into a popover, which is a request for less on screen.

## Implementation order (applied to `12`)

| Phase | Items |
|---|---|
| 1 | Tokens and shared components (unchanged) |
| 2 | Chip `{tone, icon, label}`, never null; `affected` flags on account rows |
| 3 | Shell box restyle; inline select prefixes with one baseline; then URL state, last |
| 4 | Chip rendered in the card header; count notice with "Show affected accounts" |
| 5 | Name A–Z default; fixed "Lowest limit first"; Affected chip and filter |
| 6 | Figure summary only |

*Synthesis revised after a two-pass omo-judge check.* Both passes returned REVISE. The overlapping flags were:
- unsourced external claims;
- 4b dissent missing;
- the 4b open-row rationale contradicted by the code;
- decision 3's reasoning defending the global variant;
- `12` not actually updated;
- Phase 3 coverage not stated.

All were fixed above. `12` is updated in the same change.
