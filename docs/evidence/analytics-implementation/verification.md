# Analytics implementation verification

Status: implementation and independent review complete; deployment pending.

Observe → Analytics includes Overview, Tokens & Cache, Cost, Performance,
Requests and Model Rates. The authenticated server bridge reads CPA's retained
events. CPA remains the only queue consumer. Catalog enumeration uses every
registered source, preserving occurrence identity and partial failure.

Observed before review:

- Prox: bun run verify passed, 1,984 tests, zero lint errors (six pre-existing
  React refresh warnings), TypeScript, single-file frontend and Bun server builds.
- Core v8.0.44: usage, helper and queue suites; 16 Claude/Kimi stream cases and
  existing terminal-disconnect tests; Go server build passed. Deployment instance
  serialization tests and another build passed after adding source provenance.
- CPA worker: full go test -p 2 ./..., Go build and focused regressions reported
  passed. Parent separately exercised the actual service on a copy of the
  production snapshot, with networking disabled and no collector running.
- Snapshot: 320,836 retained events, approximately 2.8 GiB. Initial 24-hour query
  took 5.249s and 30 days exceeded 28s. The supplementary-ID partial index reduced
  24 hours to 1.128s; 30 days completed in 14.679s. Index migration/open took
  10.966s. The original private SQLite backup passed quick_check.
- Browser: Playwright Chromium, actual Prox app shell, synthetic analytics and
  read-only local management transport. All six tabs, request inspector, cursor
  paging, provider filters, error state and 390px layout passed; no page errors
  or horizontal overflow. Stable screenshots used disabled animations.

Evidence logs and screenshots are under /tmp/prox-analytics-* on the build host.
The helper tests/analytics-ui-browser.mjs is reusable but was not the script used
for the observed run (/tmp/prox-analytics-browser.py).

Coverage limits remain visible: retained events do not prove all-ingress
completeness; old source IDs, missing usage and timing provenance cannot be
reconstructed. Costs use current configured rates, not historical billed rates.
Missing prices and measurements remain unavailable. Explicit supplementary
records are excluded from primary views; legacy record kinds remain unknown.
No historical token/tier rewrite or additional queue consumer was introduced.
