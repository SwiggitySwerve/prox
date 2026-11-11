# Models screen: hide old models, and hill-climb rounds 6–12

Fixture data only (the Playwright fake hub in `scripts/visual/`); no live hub was called.

- `before/` — `main` after #47 (hill-climb round 5).
- `after/` — this branch (round 10, the best-scored state; the branch's UI is identical to it).
- `matrix-r10.md` — round 10's medians per screen and aspect, every reviewer note, and the measured checks.
- `keep.md` — decisions the panel cannot reverse without a failed check or 5 of 8 seats in one round
  (K10, hiding changes no count, is a user decision and cannot be reversed by the panel at all).
- `thresholds.md` — the measured checks (contrast, colour meaning, targets, clipping, overflow, nesting),
  fixed before round 0.

## Panel

Eight seats; each cell is the median of all eight, 1–10. A cell passes at ≥ 9.0 with no failed measured check.

| seat | model |
|---|---|
| visual | Claude Opus 5.5 |
| information architecture | Claude Sonnet 5.5 |
| accessibility | Claude Sonnet 5.5 |
| visual | GPT-6.1 Sol |
| information architecture | GPT-6.1 Sol |
| accessibility | GPT-6.1 Sol |
| senior product designer | Claude Fable 5.2 |
| senior product designer | GPT 6.0 Astra |

14 screens × 9 aspects = 126 cells. S12–S14 (hiding) were added in round 6.

## Rounds

| round | cells ≥ 9.0 (of 126) | mean | lowest cell | failed checks | change tested |
|---|---|---|---|---|---|
| r6 | 49 | 8.84 | 8.1 | none | Hide feature (per-row Hide, Hidden group, Hide all not served), one right edge, shared email domain, dock under short pages |
| r7 | 61 | 8.89 | 5.8 | none* | Flat account headers where they fit, Hide on hover for served rows, hidden counts said |
| r8 | 57 | 8.87 | 8.3 | none | Upright headers whenever any header overflows its cell; one Hide rule; column counts over all models |
| r9 | 65 | 8.91 | 7.9 | none | Readable Hide icons, "N hidden · Show" above the fold, centred wide page; 44px phone button |
| r10 | 77 | 8.94 | 8.0 | none | "Show N hidden" only while the Hidden band is out of sight; "View only" note removed — **shipped** |
| r11 | 35 | 8.83 | 8.1 | none | "Set all accounts" corner label, Hide key entry, Hidden-band note, still-on icon, bordered jump, filter-bar padding, taller dock fade |
| r12 | 51 | 8.85 | 8.2 | none | r11 minus corner label, key entry and dock fade (kept note, bordered jump, icon, padding) |

\* r7's 13-account headers at 1280 were clipped, which the clipped-text check did not yet see (it measured
words, not the header cell); the panel caught it (5.8), and round 8 added header-cell overflow to the check.

The climb stopped after r11 and r12 both scored below r10, with the panel reversing itself on the same
items between them; the branch was reverted to r10's UI. The 9.0 bar is not met: 77 of 126 cells pass.

## Still below 9.0 at r10 (most-repeated)

- Row and column checkbox scope, and the icon-only Hide action (controls, ~8.6 on every screen).
- Thirteen accounts at 1280: rotated headers (responsive 8.0; the alternative, sideways scroll, is ruled out).
- Phone: toolbar height before the first row (S10 hierarchy 8.2).
- Toolbar counter wrapping to its own line at 1280; the filter row still shown over empty/error states.
