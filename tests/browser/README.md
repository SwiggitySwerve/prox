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
out-of-order responses and logout during a request. Interaction captures cover
1440, 1024 and 390 pixels, including lower content and dialog scrolling.

`analyticsViewports.ts` defines 13 responsive sizes from 320×568 to 3440×1440,
including a 3440×1300 viewport with room for browser chrome. Assertions check
overlap, clipping and target sizes throughout that matrix, plus first-chart
visibility at every desktop size from 1024px up. A separate 1024px touch context
checks 44px targets and keyboard access to measurement details.
Phone-filter checks also exercise Enter/Space, preserved selections and draft
search text, visible active-filter counts, and resizing back to desktop.

## Credential flow

`credentialFlow.browser.ts` runs the real UI against the real prox-history (store,
collector and routes) and two fake CLI-Proxy instances, started by
`tests/support/credentialFlowBackend.ts` under Bun (`BUN_BIN` overrides the Bun
binary; it defaults to `~/.local/bin/bun` when present). `credentialFlowHarness.ts`
routes the browser to them. Each scenario opens Auth Files, Accounts, Quota
Management, the Dashboard, an OAuth edit page, AI Providers and Analytics in
separate tabs of one browser and asserts that every screen shows the same
credentials: remove, add, an outside change found by the poll, a second tab
updated through the BroadcastChannel while its poller is paused, a 503 inventory
that retires nothing, and AI Providers staying identical. Nothing contacts a real
CLI-Proxy or prox-history, and no credential file is read.

When port 15173 is taken, `PROX_UI_PORT=15191 node node_modules/@playwright/test/cli.js test tests/browser/credentialFlow.browser.ts`
runs on another one (the Analytics specs hardcode 15173 and need the default).

To capture all Analytics states and measure their screenshots:

```sh
HILLCLIMB_OUT=docs/evidence/hillclimb/analytics-current bun x playwright test analyticsHillclimb
uv run --with pillow python scripts/visual/analytics-measure.py docs/evidence/hillclimb/analytics-current
```

Each of 58 cases saves an initial viewport image and DOM geometry under `fold/`,
plus a full-content image with geometry at the capture root. Full-content images
expand the viewport height; use `fold/` for height-dependent layout judgments.
Six additional captures under `expanded/` cover open phone filters on Overview
and Tokens at 320, 390 and 600px, for 122 measured images in total.
The measurement script checks painted text and series contrast, target size,
horizontal overflow, clipping, series colour separation and the shell toolbar
outline. `measurement-values.json` records the actual minima beside the failure
list in `measurements.json`.

Screenshots and failure traces are in `test-results/analytics/`; the HTML report
is in `playwright-report/`. Both are ignored by Git. Inspect the generated top,
bottom and dialog screenshots manually before committing UI changes. Passing
assertions alone do not establish visual quality or production backend behavior.
