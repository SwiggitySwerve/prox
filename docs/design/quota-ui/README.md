# Quota Management UI: restructure specs

Why: 27 rounds of blind review plateaued at about 8.45/10. The 6,242 reviewer notes show the same themes in every round from every reviewer, and they trace to structure, not polish: no layout system, no state model, no shared components, one 2,061-line stylesheet. These specs replace the page's structure so those themes close by construction.

| File | Covers |
|---|---|
| [01-findings.md](01-findings.md) | Evidence: themes, counts, root causes in the code |
| [02-foundations.md](02-foundations.md) | Tokens: spacing, type, colour meaning, shape, control sizes |
| [03-page-layout.md](03-page-layout.md) | Page regions, grid, responsive model |
| [04-components.md](04-components.md) | RefreshControl, PageStatus, Notice, PoolCard, Footer |
| [05-states.md](05-states.md) | One state model: card, row and page states, slot by slot |
| [06-accounts.md](06-accounts.md) | Accounts toolbar, table, expanded rows, narrow rows, paging |
| [07-charts.md](07-charts.md) | Chart anatomy, annotations, ticks, legends |
| [08-loading.md](08-loading.md) | Skeletons generated from the real components |
| [09-content.md](09-content.md) | Vocabulary and copy rules |
| [10-accessibility.md](10-accessibility.md) | Contrast, targets, focus, live regions |
| [11-architecture.md](11-architecture.md) | View models, component tree, styles, tests |
| [12-delivery-and-evaluation.md](12-delivery-and-evaluation.md) | Build order, how to score progress, locked decisions |
| [13-research.md](13-research.md) | Cited guidance from Carbon, Primer, Cloudscape, Atlassian, GOV.UK, NN/g, W3C, Datawrapper; specs cite it as `[R§n]` |
| [14-council-decisions.md](14-council-decisions.md) | Council outcomes on the four open decisions |

Every spec opens with the finding themes it closes. A theme with no owning spec is a gap.

## How these were made

1. **Draft** from the theme analysis in `01-findings.md`.
2. **Research**: design-system and practitioner guidance on the same twelve topics (`13-research.md`).
3. **Critique**: an independent reviewer read the draft against the findings and current captures, and listed what would still score below 9.0, contradictions, gaps and flip-flop risks.
4. **Revision**: everything below changed as a result.

### What changed after research and critique

- **One icon per status.** The draft gave the clock to both Saved and Stale, and ⚠ to both Low and Unavailable. Now: Low ⚠, Failed ⊗, Partial ◐, Stale ◷, Saved (history), Info ⓘ.
- **Critical red** applies to low quota and failed requests alike (the draft contradicted itself). It is #ff4d6d, because the app's `--error-color` is only ΔE 19.6 from Claude coral.
- **Rate interval and Future usage** stay page-level and inline, with the name as a prefix inside each select (council, `14`).
- **RefreshControl** has a fixed accessible name and a 32ch box, and countdown ticks never reach the live region. The draft's label changed every second, and its 22ch box was too narrow.
- **Refresh failure is said once**, in the page notice, which owns the retry. The draft said it in six places.
- **Page notice placement** moved under the page header, above the view bar, following Primer and GOV.UK placement for page-wide messages. Raw error codes go behind Details (Cloudscape).
- **Card notices** get "Show affected accounts" (filter and sort first) instead of a refresh action, so a missing account on page 5 of 200 is one click away.
- **Fact slots reserve three lines**, and four across only at ≥ 1200px card width. The combined card's facts are defined, and the group title names the window ("5-hour forecast").
- **Withheld headline**: the em dash stays, and the context line becomes the reason ("Withheld · 2 of 3 current").
- **Chart marker** shows the reading's time instead of "Now", which would be false for stale data. There's a low zone, a horizon label, a reset-label budget and `figure` semantics with a summary sentence.
- **Accounts**: the low chip is labelled with its rule ("Below 20%"), default sort is "Name A–Z", search resets paging, and Expand all only appears at ≤ 25 rows (Carbon). Headers are sticky on long rosters, there's one empty-cell pattern, and plans read "Pro · 100 points" everywhere.
- **"of"** keeps one meaning per form: capacity "of 300 points", coverage "2 of 3 current", paging "Showing 25 of 120".
- **Neutral "Ready" chip** in one shape for every state (council, `14`). Skeletons get their own surface token, controls are never skeletons (Carbon), and reduced motion keeps a gentle pulse (Primer).
- **Phone**: Window and Measure stay visible as segmented controls, and only the settings go in a sheet. Primer advises against hiding or wrapping segmented controls.
- **Decision log** in `12` locks the nine choices reviewers flip-flopped on, so a single dissenting note can't reopen them.
