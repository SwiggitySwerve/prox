<!-- Research notes gathered for these specs. Every rule cites its source; specs reference rules here as [R§n]. -->

# Dashboard design rules from design systems and practitioners

Coverage is uneven. Topics 1, 3, 5 and 10 have strong primary sources. Topics 8 and 11 are thinner. For the gaps, I've labelled weaker sources or said that no source was found.

## 1. Page anatomy and filters
- Rank content by importance. Put the most important data at the top, with the highest contrast and the largest area (F-pattern). https://carbondesignsystem.com/data-visualization/dashboards/
- A global filter, such as a date range across all charts, can be paired with child filters that sit on one item only. Complex filtering belongs on a details page, not the dashboard. https://cloudscape.design/patterns/general/service-dashboard/dashboard-items/
- Each item header holds a title, plus an optional description, counter or info link. Give it one primary action at most, and group secondary actions in one icon dropdown. Each item serves one goal and uses no more than 2 visualization types. https://cloudscape.design/patterns/general/service-dashboard/dashboard-items/
- Page-level refresh goes in the header actions. Don't add more refresh buttons unless part of the UI genuinely refreshes on its own. https://cloudscape.design/patterns/general/loading-and-refreshing/
- Promote no more than 2–3 filters, and plan for small screens when deciding how many filters to include. https://polaris-react.shopify.com/components/selection-and-input/filters
- Segmented controls must have a text label, though it may be visually hidden when the surrounding context is clear. Use 2–5 text segments or up to 6 icon-only ones. They suit sort, filter and format switches. A filter version must include a segment that shows everything. https://primer.style/product/components/segmented-control/guidelines/
- Field labels sit outside the field, in sentence case, with no colons. Placeholder text never replaces a label. Use one field height across a page. https://carbondesignsystem.com/components/text-input/usage/
- When one chart is filtered or zoomed, linked charts should mirror the change. Keep legends in the same position relative to the plot on every chart. https://carbondesignsystem.com/data-visualization/dashboards/

## 2. KPI / big-number cards
- Use dedicated metric type styles: 28/32, 24/28 and 16/20 px, all bold. https://atlassian.design/foundations/typography/
- A change indicator needs "+" or "−", a caret or an arrow, not color alone. Green is positive and red is negative, except for temperature data. https://carbondesignsystem.com/patterns/status-indicator-pattern/
- Give the number context: a target (bullet chart rather than gauge), the full scale, or recent history ("as much as recent newsletters?"). https://www.nngroup.com/articles/dashboards-preattentive/
- Missing values: never leave the slot blank. First choice is explicit text about why it's null. Fall back to an em dash (—) when the reason is unknown. https://helios.hashicorp.design/content/components/tables
- Fact grids: use a `<dl>` with key → value pairs. Don't use it for tabular data. For a missing value, put a link to the place the user can fix it in the value slot. https://design-system.service.gov.uk/components/summary-list/
- Card size: small cards (3 of 12 columns) hold a single data point. Extra-large cards (12 of 12) suit a key-metrics overview. All cards collapse to one full-width column at small breakpoints. https://cloudscape.design/patterns/general/service-dashboard/dashboard-items/

## 3. Inline notifications and banners
- Use one component with tones: info (blue), success (green), warning (yellow), error (red). Each tone has a fixed icon. https://carbondesignsystem.com/components/notification/usage/
- Inline notifications go at the top of the primary content area or next to the item they concern. Keep them to 2 lines or less, allow only one action, and never dismiss them automatically. Don't show a close button if the message is critical. https://carbondesignsystem.com/components/notification/usage/
- Show no more than one banner per page. Place it near the section it concerns, or above the page heading for page-wide messages. Allow 2 actions at most and prefer one. Only show success messages when success isn't already visible in the UI. https://primer.style/product/components/banner/guidelines/
- Put a page banner directly before the h1, at content width. If you have several messages, show only the highest-priority one. https://design-system.service.gov.uk/components/notification-banner
- Scope: whole site → banner. One section → section message. After an event → flag. Never rely on color for severity, and avoid dead ends. https://atlassian.design/components/section-message/usage
- Section-level failure: replace that section's content with the error alert and keep the rest of the page usable. Page-level failure: replace the main content. https://cloudscape.design/patterns/general/errors/error-messages/

## 4. Data tables
- Right-align numeric columns, header cell included. https://design-system.service.gov.uk/components/table/ and https://primer.style/product/components/data-table/
- Use tabular figures (`font-variant-numeric: tabular-nums`) so digits line up in columns. No design-system source states this; MDN is the reference. https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric
- Headers: 1–2 words, sentence case. Long titles wrap to 2 lines, then truncate with a tooltip. The header row is the same height as body rows. https://carbondesignsystem.com/components/data-table/usage/
- Row actions go in the last column, with a visually hidden "Actions" header. Pull out at most one frequently used action. If the table is sortable, one column must be sorted by default. https://primer.style/product/components/data-table/
- Row heights are 24, 32, 40 (default), 48 and 64 px. The toolbar and pagination match the row height. Put no more than 5 actions in the toolbar. Pagination always sits at the bottom. https://carbondesignsystem.com/components/data-table/usage/
- Expandable rows hold extra or slow-to-load detail. If the detail is cramped, move it to a side panel or page. Don't show expand-all by default. https://carbondesignsystem.com/components/data-table/usage/
- On mobile: sticky headers, a frozen first column, and a cut-off last column to signal horizontal scroll. Let users choose which columns to show, and use accordions for grouped data. https://www.nngroup.com/articles/mobile-tables/
- Use pagination or "Load more" for goal-oriented lists, and avoid infinite scroll. With "Load more", show "X of Y" items viewed. https://www.nngroup.com/articles/infinite-scrolling-tips/
- Filter chips: selecting one adds a leading checkmark. Label chips with nouns. https://m3.material.io/components/chips/guidelines

## 5. Loading states
- First load uses skeleton rows, which keep the column layout. Spinners in tables cause layout shift. Keep showing existing data during a refresh. https://cloudscape.design/patterns/general/loading-and-refreshing/
- Load the page skeleton and non-data text first, then data. A placeholder can simply be empty space of the final size. Don't give skeletons to buttons, inputs or toggles. https://carbondesignsystem.com/patterns/loading-pattern/
- Timing:
  - Under 1 s: show no loading indicator.
  - 1–3 s: indeterminate indicator.
  - Over 3 s: determinate if possible.
  - Over 10 s: run it as a background task.
  
  Replace a row of adjacent loading indicators with one, and make one screen-reader announcement for a group of skeletons. https://primer.style/product/ui-patterns/loading/
- Skeletons must mirror the final layout; frame-only skeletons are no better than a spinner. NN/g prefers a spinner for a single card. That conflicts with Cloudscape's skeleton-for-tables rule; follow Cloudscape for tables. https://www.nngroup.com/articles/skeleton-screens/
- Reduced motion: keep loading animation subtle, but don't turn it off. https://primer.style/product/ui-patterns/loading/

## 6. Refresh and sync status
- Show a "Last updated" timestamp after each refresh, in absolute time with a UTC offset, and announce it through an ARIA live region. Give the refresh button `loadingText`. https://cloudscape.design/patterns/general/loading-and-refreshing/
- If a refresh takes longer than 1–10 s, put a pending status next to the refresh button. If it partly or fully fails, use a warning status with a popover that explains and offers retry. https://cloudscape.design/patterns/general/loading-and-refreshing/
- Use `role="status"` (polite) for results and progress. Reserve `role="alert"` for urgent messages; using it on non-urgent content is a listed WCAG failure. https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- The `role="status"` element must always be in the DOM, not only when there's a message. Use `aria-busy` during partial updates. https://primer.style/product/ui-patterns/loading/

## 7. Empty and error states
- Anatomy: optional image, a short title (phrased positively), a body explaining the next step, one primary action, and an optional secondary link. https://carbondesignsystem.com/patterns/empty-states-pattern/
- Left-align the empty state as a block, and replace the element it stands in for (no empty table headers). If several widgets fail at once, use text only and tertiary buttons. Error copy is plain language with no codes. https://carbondesignsystem.com/patterns/empty-states-pattern/
- Never show "No records" while still loading. Pair any instruction with a direct way to act on it. https://www.nngroup.com/articles/empty-state-interface-design/
- Error copy: say why it happened and what to do next. Don't show raw machine errors as the main message; put them in an expandable section. Don't make false promises such as "we've been notified". https://cloudscape.design/patterns/general/errors/error-messages/

## 8. Stale, degraded and partial data
- Put a pending or warning status indicator, with an explanation, next to the refresh control rather than scattered around the page. https://cloudscape.design/patterns/general/loading-and-refreshing/
- A grouped status takes the most severe member's color (green + yellow + red = red). Combine at least 2 of color, shape and symbol, plus a label. https://carbondesignsystem.com/patterns/status-indicator-pattern/
- When data can't load, show the last good snapshot labelled "Data as of 10:42 AM". This is a practitioner source, not a design system. https://www.smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/
- Never interpolate across missing periods, and label the start and end of each gap. https://carbondesignsystem.com/data-visualization/axes-and-labels/

## 9. Responsive design
- Use `@media` for the page shell, modals and off-canvas panels, and `@container` for reusable cards and tables. This is a practitioner source; I found no design-system rule. https://www.smashingmagazine.com/2026/09/stop-treating-css-container-queries-traditional-media-queries/
- Primer's narrow range is under 768 px (1 column), regular is 768 px and up, and wide is 1400 px and up. On narrow screens, auxiliary panes can become bottom sheets or stack. https://primer.style/product/getting-started/foundations/layout/
- Narrow segmented controls switch to icons or an ActionMenu. Never wrap them onto two lines or drop options. https://primer.style/product/components/segmented-control/guidelines/
- On mobile, a legend can collapse behind a "View legends" button. https://carbondesignsystem.com/data-visualization/legends/
- Target size: at least 24×24 CSS px (AA), or smaller with a 24 px clear circle around it. https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
  - 44×44 is the AAA level (SC 2.5.5).
  - Android/Material recommends 48×48 dp with 8 dp gaps. https://support.google.com/accessibility/android/answer/7101858
- Reflow at 320 CSS px with no two-way scrolling. Data tables and charts are exempt, but headings, search and pagination around them must still reflow. https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

## 10. Charts
- Label lines directly where you can. Use a legend only when space for labels isn't guaranteed. Skip the legend for a single series. Keep legends under 30% of chart height, and place them top or bottom on dashboards. https://carbondesignsystem.com/data-visualization/legends/
- If a label won't fit, put it at the right-hand end of the line. Use about 10 gridlines at most, in light grey. Label the final tick. Use no more than about 4 lines per chart. https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-charts/
- Dashed or textured lines tend to be read as forecast or provisional data. Reserve dashes for projections only, and never use them to bridge gaps. https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-charts/
- Mark the switch to projected values with a highlight range. Grey out context series. https://www.datawrapper.de/blog/line-charts
- Keep annotations short and next to their data, and don't let them cover it. I found no published rule for collisions between labels like "Now" and event ticks. https://carbondesignsystem.com/data-visualization/dashboards/
- Use stacked areas only when the total matters, the data runs over time, and there are many dates. Upper bands are hard to compare; use lines to compare shares. https://www.datawrapper.de/blog/area-charts
  - Limit stacks to about 4 categories. https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-charts/
- Area and bar axes start at zero; line axes may be cropped. Never change tick increments to fit the data you have. https://carbondesignsystem.com/data-visualization/axes-and-labels/
- Every data line needs 3:1 contrast against the background, and very thin lines should be avoided. https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- Use one consistent color per data set across the whole dashboard. https://carbondesignsystem.com/data-visualization/dashboards/

## 11. Tokens, spacing and type
- Spacing scale: 2, 4, 8, 12, 16, 24, 32, 40, 48, 64… Avoid values outside it. https://carbondesignsystem.com/elements/spacing/overview/
- Type scale: 7 sizes (12/14/16/20/24/28/32). 14/20 is the default body. Line height is generally size + 4 px. https://atlassian.design/foundations/typography/
- Control heights are 24, 32, 40 (default) and 48 px, and one height is used per page. https://carbondesignsystem.com/components/text-input/usage/
- Page padding is 16 px, or 24 px at 1280 px and wider. https://primer.style/product/getting-started/foundations/layout/
- I found no primary source for a single radius family or icon-button sizes, so I left them out.

## 12. Color in dark UIs
- Semantic roles: danger for serious errors, warning for caution, information for in-progress states. Accent colors carry no meaning. Don't use an accent where a color means something; this is what keeps a brand coral from being read as an error. https://atlassian.design/foundations/color
- Contrast: 4.5:1 for text under 24 px, 3:1 for essential UI and text 24 px or larger. https://atlassian.design/foundations/color
- Build with functional tokens. Base tokens ignore light and dark mode, and neutral scales flip between the two. https://primer.style/product/getting-started/foundations/color-usage/
- Status colors: red for error, orange for serious warning, yellow for warning, green for success, blue for info, gray for not started. Status colors need 3:1 against each other and the background, and must still be distinguishable in grayscale. Don't use more than 5–6 indicators. https://carbondesignsystem.com/patterns/status-indicator-pattern/
- Never use color to show magnitude. Use it only to reinforce something already shown another way. https://www.nngroup.com/articles/dashboards-preattentive/
