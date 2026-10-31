# Accessibility

Closes: small grey text, icon button targets, focus visibility, live regions, colour-only status, masked email readability.

- **Contrast** [R§12]: text ≥ 4.5:1 against its real background (including notice and error tints); bars, chart lines, control borders and the focus ring ≥ 3:1 [R§10]. Disabled controls are exempt; their reason text is not.
- **Targets** [R§9]: 24px minimum; 44px on coarse pointers; icon buttons always sit in a 32/44px box.
- **Focus**: a 2px white ring with 2px offset on every interactive element, including table rows and the chart.
- **Names**: icon buttons have accessible names and visible tooltips ("Collapse Claude chart"). RefreshControl's name is fixed ("Refresh quotas"); its changing status is a description.
- **Live regions** [R§6]: one persistent `role="status"` region for refresh and loading state changes, never countdown ticks; `role="alert"` only for a first-load failure.
- **Status** is never colour alone: a word plus an icon, each icon used for one status only.
- **Segmented controls** carry a visually hidden group label [R§1].
- **Tables**: `<table>` with `scope`d headers on wide; on narrow, a list whose items expose the same names; expandable rows are buttons with `aria-expanded` / `aria-controls`.
- **Charts**: a focusable `figure` with `aria-roledescription="chart"` and a summary sentence; arrow-key inspection with a throttled polite readout. ("View as table" is deferred; council decision 4d.)
- **Masked accounts** get an accessible label ("account ending …ce at ex…test").
- **Reduced motion**: spinners and shimmer become a gentle opacity pulse [R§5].
- **Reflow** [R§9]: usable at 320px and 400% zoom; only the chart and table scroll inside themselves.
