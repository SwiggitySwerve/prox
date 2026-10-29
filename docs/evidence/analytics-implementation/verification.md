# Analytics implementation verification

Status: deployed on 2026-10-29. Local tests, independent review and authenticated
live checks passed. Release-head remote CI and public SSO sign-in were not run.

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


## Deployment and live acceptance

Deployed revisions:

| Service | Revision | Image tag |
| --- | --- | --- |
| Prox UI | `0cc4015` | `localhost/prox:analytics-final-20261029` |
| Prox history / Analytics bridge | `8a67c3b` | `localhost/prox-history:analytics-8a67c3b` |
| CPA Manager | `67fbac59` | `localhost/cpa-manager-plus:analytics-67fbac59` |
| GPT and Claude core v8.0.44 | `85eabdce` | `localhost/cli-proxy-api:analytics-85eabdce` |

All code was committed and pushed directly under the user's no-PR instruction.
CPA was restarted first, then history/UI, then Claude and GPT sequentially.
Core shutdown closes HTTP, so this was not a zero-interruption release.
Ports, LAN bindings, auth stores and catalogs were preserved. The existing Usage
panel response matches the mounted panel file by SHA-256. CPA remains the only
usage queue consumer; no live queue was queried directly during verification.

Authenticated live API checks passed for 24 hours, 30 days, separate Claude and
Codex filters and non-overlapping cursor pages. Both catalog sources are ready:
10 registered models, 9 with configured prices. `gpt-6.1-terra` has no configured
price and remains explicitly unpriced. The 30-day query returned 322,094 retained
events in 11.454s; counts change as traffic continues. The first 24-hour query took
2.278s, and subsequent filtered/page queries took 0.651–0.742s.

New naturally occurring traffic from both providers was observed through CPA's
retained Analytics API after the core restarts. Source IDs are `codex-primary` and
`claude-primary`. The sampled new records report usage presence and timing offsets;
observed TTFT methods were substantive content for Codex and first byte for Claude.
These methods remain visibly distinguished and must not be treated as equivalent.
No extra inference or queue reader was needed for this check.

Playwright ran against the deployed UI at loopback port 18318, with real Analytics
responses and external browser requests blocked. Final acceptance covered all six
tabs, request details, next/previous pages, provider selection/reset, timeline-bar
drilldown into Requests, and 390px Overview/Requests/Model Rates layouts. There
were zero page errors and no document-level horizontal overflow. Final screenshots
were visually inspected. Large real token totals exposed a summary-card width
issue; the one-line CSS correction is included in `0cc4015`. Mobile summary values
were also checked for one-line fit. No numeric rounding or pricing changed.

After that correction, `bun run verify` passed: 1,985 tests, zero failures, zero
lint errors, six existing React-refresh warnings, TypeScript, frontend and server
builds. The correction also passed synthetic and live browser checks. Sol's final
approval covers the prior functional release; the subsequent change only widens
summary cards from 155px to 240px minimum.

Public Prox and Usage hosts both return HTTP 200 through the existing Authentik
redirect. A full public SSO sign-in was not performed; authenticated application
acceptance used the local production endpoint.

Rollback images are retained as `rollback-pre-analytics-20261029`. Exact previous
quadlets are privately backed up under `~/.local/share/prox/rollback-analytics-20261029`.
The private SQLite backup remains intact. The older v8.0.43 worker checkout was
not deployed or blindly reset: its current test file differs from the transfer
patch, so cleanup was left untouched rather than discarding an unmatched edit.

## Pipeline-health evidence

- **CI at merge:** NOT-RUN — direct pushes; no release-head Actions runs were
  observed in the three fork repositories. Local required checks passed.
- **Post-merge validation:** PASS — authenticated production API/browser checks,
  deployed image revisions, both providers' new measurement records, preserved
  Usage panel and health endpoints; see `deployment.json` and `live-api.json`.
- **Error-log baseline:** PASS — predeployment panic/fatal baseline was zero over
  five minutes. Postdeployment error/panic/fatal counts were zero for all five
  containers, over the last five minutes or since startup for younger containers;
  zero threshold. This is a bounded log sample, not long-term health evidence.

Host-local evidence: `/tmp/prox-analytics-live-probe.log`,
`/tmp/prox-analytics-live-browser-final.log`,
`/tmp/prox-analytics-ui-correction-verify.log`,
`/tmp/prox-analytics-browser/live-*.png`. Browser evidence uses the script
`/tmp/prox-analytics-browser.py`; synthetic runs are labeled separately.
