# Analytics presentation

CPA owns token accounting, cost, coverage, rate resolution and performance metrics through
`src/domain/analytics/types.ts`. This feature renders those values; it must not calculate
prices, token relationships, ratios or aggregate metrics from request pages.

The UI owns UTC range selection, cursor navigation, formatting and chart geometry. Timeline
bars use actual bucket timestamps and never connect missing measurements. A chart drilldown
retains all query filters and clears only pagination. Rate inventory is a current configured
rate reference, including unused/unpriced registrations; it is not historical spend.

`createAnalyticsApi` captures the authenticated connection. `useAnalytics` aborts on query,
session or refresh changes and hides results whose query/session no longer match. It reuses
the existing auth-transition observer from quotaPool rather than duplicating reconnect rules.
Request details project named operational fields only; never enumerate arbitrary payload keys.

Synthetic tests and browser exercises use no real credentials, collectors or queues.
