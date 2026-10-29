# Analytics local UI review — 2026-10-29

Scope: the new Analytics page and its six views, using the real app shell with
fully synthetic HTTP responses. No production request, credential, queue or
collector was needed for this local review. No commit or deployment was made
before the review cycle.

## Cycle and findings

| Finding | Reproduction | Correction | Evidence |
| --- | --- | --- | --- |
| Provider/model choices disappear while a query is pending | Hold the Claude response, then try selecting Codex | Reuse the last result's filter choices only within the same authenticated session and connection revision; keep result data hidden until its query matches | Browser delayed-response scenario; logout isolation scenario |
| Chart inspection shows the previous metric | Focus Claude's 128-event bar, then select Tokens & Cache | Store the inspected category key and resolve its value from the current data | Browser regression now displays Claude: 12,500 |
| Details label breaks mid-word | Long model names in the narrow request table | Keep the action cell on one line | 390px dialog/table screenshots and layout check |
| Missing rate label breaks mid-word | Unpriced model in a full-width rate table | Keep the four price columns on one line inside the existing scroll region | Price-cell text rectangle checks and rate screenshots |

The first two failures were reproduced before the fixes. Initial browser failures
also exposed harness mistakes: a heading was selected instead of a details
summary, the mobile navigation drawer needed opening, and an option's implicit
value was incorrectly queried as an HTML attribute. Those were corrected in the
test harness, not treated as application defects.

The empty fixture was corrected to use unavailable timing/cost fields when there
are no events. The explicit-zero fixture remains separate. Synthetic fixtures
exercise rendering and transport; they do not verify CPA accounting arithmetic.

## Automated acceptance

`bun run test:ui:analytics` typechecks the browser tests, launches an owned Vite
server on loopback port 15173, and runs pinned Playwright Chromium. It refuses to
reuse an unrelated server. Every unmocked API/external request is blocked and
fails the test. Service workers are blocked and WebSockets closed. The server and
browser contexts are shut down after the run. Instructions are in
`tests/browser/README.md`.

The 10 scenarios exercise all tabs, range/provider/model/outcome/search filters,
clear/refresh/retry, server-cursor paging, keyboard chart drilldown, chart-table
alternatives, expanded context/service-tier schedules, request detail scrolling
and focus return, large values/long names, partial catalog availability,
empty/unknown/explicit-zero values, loading and 503/404/500 failures,
out-of-order replies, and logout while a request is pending.

The previous standalone browser helper was replaced by this executable suite,
using the existing shared Analytics fixture owner. No duplicate browser workflow
or second Analytics implementation was introduced.

## Manual visual inspection

Reviewed 61 captures, grouped into contact sheets, and inspected detailed mobile,
laptop and desktop images where needed. The capture matrix includes:

- All six views at 1440×1000, 1024×1000 and 390×844, top and lower content.
- Long-name request dialogs at all three widths, top and scrolled metadata.
- Empty, unavailable and explicit-zero Overview/Performance/Requests/Model Rates.
- Loading, three error types, mobile error, expanded model rates and chart tables.

Checked alignment, totals, labels, chart gaps, unavailable versus zero,
long-name wrapping, scroll containment, dialog access and the Details action.
The final rate-cell and empty-fixture captures were regenerated and reinspected;
rate labels now stay on one line and empty timings remain unavailable. Large tables retain intentional horizontal
scrolling inside their regions; document-level overflow is disallowed.

Host artifacts: `test-results/analytics/`, `playwright-report/` and the preserved
review captures in `/tmp/prox-analytics-local-review/`. These are synthetic and
ignored by Git. Passing local mocks does not prove live backend behavior,
all-ingress completeness, pricing accuracy or a public SSO sign-in.

Final local verification passed before commit: all 10 browser scenarios (33.7s),
1,985 Bun tests, zero lint errors (six pre-existing warnings), browser TypeScript,
application/server TypeScript, single-file frontend and server builds. Focused
Analytics unit/transport checks separately passed 21 tests. No browser runtime
errors or unmocked backend/external requests occurred. Browser artifacts contain
61 final captures.

## Independent review

Reviewed with sol-loop: one round with GPT-6.1 Sol, high reasoning effort,
through the configured GPT proxy. Verdict: APPROVE. No actionable findings or
unresolved objections; no declined findings. Review token usage was not returned.
The reviewer inspected the full diff, new files, four contact sheets and a detailed
rate-table capture. Its independent rerun passed all 10 browser tests in 32.5s.
An earlier reviewer run passed nine tests and encountered one local asset-loading
ERR_NETWORK_CHANGED timeout; the complete rerun passed. No source edits were
made during review. No live request or credential read occurred during this
local review cycle. Deployment and post-release checks follow this approval.

Logs: `/tmp/prox-analytics-mock-final.log`,
`/tmp/prox-analytics-local-verify.log`, `/tmp/prox-analytics-focused.log`.
