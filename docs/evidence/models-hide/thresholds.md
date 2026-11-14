# Models grid hill-climb — measured-check thresholds (fixed 2026-11-11, before round 0)

Prox has one dark theme; every capture is dark. Colours are read from screenshot pixels.

- Text contrast vs its rendered background: >= 4.5:1 (text under 18.66px bold / 24px), large 3:1.
  Foreground = the pixel in the element's box with the highest contrast against the box's
  modal (background) colour.
- Meaningful non-text (switch track/outline vs the cell background): >= 3:1.
- On vs off switch (must be told apart): track luminance contrast between an on and an off
  switch >= 3:1, and thumb position differs.
- Mixed switch: CIE76 dE >= 15 from both on and off tracks.
- Staged ring (warning-text #f1dba8) reads as amber: hue 30-60 deg, saturation >= 0.25 (HSV),
  dE >= 20 from the danger colour and from the on track.
- Failed marker / Not saved (danger) reads as red: hue 340-20 deg, S >= 0.35; dE >= 20 from amber.
- "Couldn't read" marker (warning-text) reads as amber, same rule as the staged ring.
- Targets: >= 24x24 CSS px at >= 600px wide; >= 44x44 on the 390 phone layout.
- Overflow: no page sideways scroll at 1280/1440/2000; no clipped status/label/button text.
- Nesting (grouping-checks.js): maxDepth < 4. Hidden reason: none.
