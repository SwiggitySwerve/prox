# Charts

Closes: reset tick collision, axis ticks, snapshot at the edge, legend wrap, latest reading repeat, low red vs coral, drain vs burn, stacked select position.

## Anatomy

```
━ Claude  ━ Codex        ── Recorded  ╌ Projected  ┊ Reset          ← legend above the plot, two groups [R§10]
points                12:00 PM
500 ┤ ░░░░░░░░░░░░░░░░░░░┃░░░░░░░░░░░░░░░ low zone (< 20%)
    │   ━━━━━━━━━━━━━━━━━┃╌╌╌╲   +100
250 ┤                    ┃    ╲  ┊
  0 ┼────────────────────┸─────╲─┊──────────── empty after Nov 10 →
    Oct 25     Oct 27     Oct 29     Oct 31     Nov 2
[hover readout line, height reserved]
```

## Rules

- **Latest-reading marker** is labelled with the reading's time ("12:00 PM"), not "Now" or "Snapshot": the time stays true when data is stale or saved, and it carries its own age. There is no static footer repeating it; the footer line is the hover/focus readout, with its height reserved.
- **Annotation layout**: one collision pass places every label (marker time, reset gains, edge label). Labels never overlap and never leave the plot; when a reset falls within 24px of the marker, the two merge into one label ("12:00 PM · reset +100") [R§10: annotations near their data, never covering it].
- **Resets**: label the next three; further resets are unlabelled ticks, with "Resets every 5h · +38 points" in the legend (the 5-hour view has about 48 resets in 10 days).
- **Ticks**: 3–6 x ticks at every width, final tick labelled [R§10]; the 5-hour view uses hour ticks with the date at day boundaries. Tick text is `type-label` (13px).
- **Low zone**: a faint band below 20% of capacity, matching the accounts' "Below 20%" rule, so the chart and the table agree on what "low" means.
- **Horizon**: when the projection runs past the visible range, an edge label states where it goes ("empty after Nov 10 →"); the "Pool empty" fact uses the same horizon.
- **Gaps**: never interpolate across missing periods; label where readings stop [R§8].
- **Stacked view** only in Remaining, where the total matters [R§10]; bands at 0.35 recorded / 0.18 projected fill with a 1px top stroke in the series colour so thin bands stay visible; the total is a neutral line on top. Rate views show provider lines.
- **Projected** is the same hue, dashed; dashes are never used for anything else [R§10].
- **Flat series** in rate views: no per-sample dots; 20% y-headroom; right padding of one tick gap so end markers never clip.
- **Heights**: 280px wide, 240px medium, 220px narrow; collecting state 96px strip ("1 reading so far").
- **Colour**: series in their provider colours; critical red never appears in charts except the low zone's edge.
- **Accessibility**: a focusable `figure` with `aria-roledescription="chart"` and a text summary, arrow-key inspection with a throttled polite readout [R§10, `10-accessibility.md`]. "View as table" is deferred (council decision 4d).
- **Shared crosshair** (later): hovering one chart shows the same moment on every card.
