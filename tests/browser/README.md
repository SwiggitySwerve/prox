# Analytics local UI verification

Run from the repository root:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run test:ui:analytics
```

The command typechecks the browser tests, starts its own loopback Vite server on
15173, runs Chromium and stops the server. It refuses to reuse an existing server.
Playwright must have its pinned Chromium installed; no production credential is
needed. `node node_modules/@playwright/test/cli.js test --grep '<test name>'` runs
an individual scenario after the initial setup.

The real app shell and components are used. Login, provider discovery, config,
catalog, auth inventory and Analytics HTTP responses are synthetic. HTTP routing
allows only local Vite assets and explicit mock endpoints; unexpected API or
external requests are blocked and fail the test. WebSockets are closed and service
workers disabled. No live collector, queue, account or management key is read.
The unrelated pool request made by the landing page is explicitly mocked as 503.

`tests/fixtures/analyticsUi.ts` owns canned responses shared with component tests.
They exercise presentation and query transport, not CPA's accounting arithmetic.
`analyticsHarness.ts` owns mock transport/session setup; `analytics.browser.ts`
owns user flows and layout checks. This replaces the old unconnected
`tests/analytics-ui-browser.mjs` helper.

Coverage includes all six tabs, provider/model/outcome/search/date filters,
refresh/retry, paging, keyboard chart drilldown, chart table alternatives, model
rate schedules, request-dialog focus return, large values, long names, partial
catalog availability, empty/unknown/explicit-zero data, loading and HTTP errors,
out-of-order responses and logout during a request. Layout captures cover 1440,
1024 and 390 pixels, including lower content and dialog scrolling.

Screenshots and failure traces are in `test-results/analytics/`; the HTML report
is in `playwright-report/`. Both are ignored by Git. Inspect the generated top,
bottom and dialog screenshots manually before committing UI changes. Passing
assertions alone do not establish visual quality or production backend behavior.
