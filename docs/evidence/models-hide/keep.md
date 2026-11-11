# Models hill-climb keep list (written before round 6, from r3–r5 reviews)

A kept decision is not reversed unless a measured check fails or at least five of the eight seats
ask for the reversal in the same round. Evidence = seats that asked for it or praised it in r3–r5
notes (no seat asked to undo any of these).

| # | Decision | Endorsed by (r3–r5) |
|---|---|---|
| K1 | Row/column bulk controls are tri-state checkboxes (dash = some on), not switches | all 8: no seat asks to revert; r1–r3 "worse/better" lists name the dash as an improvement |
| K2 | Rows grouped in labelled Served / Not served bands by saved state; staged rows do not move | 6: Opus, Sonnet IA, Sol visual, Sol IA, Astra, Fable ask only for clearer wording, never removal |
| K3 | A labelled key ("Key") drawn with small samples replaces the explanatory sentence | 6: Sol visual, Sol a11y, Astra, Fable, Opus, Sonnet a11y asked for "Key" label + smaller samples (r3), none asked for the sentence back |
| K4 | Flat (horizontal) account headers wherever they fit; upright only when a word would be cut | 8: every seat flagged r4's upright headers at 2000 |
| K5 | Page scroll with a sticky account header (no inner scrollbar) | 6: asked for in r0–r2 by Opus, Fable, Sonnet IA, Sol visual, Sol IA, Astra; kept since |
| K6 | One right edge for toolbar and grid at wide widths (no dead band inside or beside the grid) | 7: Opus, Sonnet IA, Sonnet a11y, Sol visual, Sol a11y, Astra, Fable (r3–r5 S01 layout notes) |
| K7 | One count format "n/m on" on both axes | 5: Opus, Sonnet IA, Fable, Sol visual, Sonnet a11y (r2 flagged "3/6" vs "4/20 on") |
| K8 | Red "Save failed" (failure) vs amber "Unsaved" (staged) words and colours | 5: Fable, Opus, Sonnet IA, Sol IA, Astra (r2–r3) |
| K9 | Switch/checkbox hit areas ≥24px (44px on phones) | measured check |

Open, not kept (no 5-seat majority either way): the "All models" corner label (r5: Opus and Fable
read it as the count column's heading; Astra and Sol IA asked for axis labels); per-row "on" unit
(Fable and Opus ask to state it once); account email size (several ask 12–13px, which conflicts
with K4 at 13 accounts × 2000).
- K10 (user decision, 2026-11-11; NOT reversible by the panel): hiding a model changes no count.
  The per-account "n/m on" count, the account header's all-models checkbox state, and the toolbar
  summary ("20 models · 4 served · 4 accounts") all include hidden models; only the rows move into
  the Hidden group. Guarded by tests/modelsHiddenCounts.test.ts. Note it in the PR.
