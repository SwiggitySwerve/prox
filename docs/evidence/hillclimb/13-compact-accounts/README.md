# Compact accounts, forecasts and refresh controls

Validated on 2026-10-28 with synthetic quota data in the actual application shell.
The repeatable capture script is `scripts/visual/prox-quota-capture.py`.

All 15 captured states pass the script's overflow, clipping, target, rendered
contrast and provider-colour checks with no page errors. Wide, laptop and narrow
checks also verify that the countdown changes, that the duplicate page refresh
button is absent, and that the header does not cover the countdown. Expand all
and Collapse all affect every account in the selected pool.

The refresh-error case uses the header refresh control. It verifies and dismisses
the resulting notification before capturing the persistent error banner. The
notification temporarily obscures part of the page; these contrast measurements
describe the page after dismissal, not the notification overlay.

Screenshot chart values are fixtures. The forecast correction is covered by the
domain regression for two drained accounts, subsequent resets, and continuing
pool demand. Local-midnight tick tests cover the Denver timezone.

`bun run verify` passed 1,946 tests, TypeScript, production builds, and ESLint
(zero errors, six existing Fast Refresh warnings). Sol approved the forecast and
compact-account changes before the refresh-countdown/branding additions; those
later additions received local regression and browser verification.
