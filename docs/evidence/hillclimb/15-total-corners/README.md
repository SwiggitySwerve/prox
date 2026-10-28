# Compact corner controls and combined totals

Minimize is an icon-only control beside each provider card's up/down controls,
with a matching corner icon on the combined chart. Desktop targets are 28px;
mobile targets remain 44px. Accessible labels and tooltips name the graph.
The combined card offers Provider Lines and Combined Total; existing provider
filters select the contributors to both views.

The server computes totals using the existing historical account rules and the
sum of independent provider forecasts, preserving reset jumps and null gaps.
It never moves demand between providers or counts unverified same-provider
sources twice. The browser only draws the returned series.

Verification:
- 64 exact before/after dashboard comparisons for the history extraction.
- Eight new domain tests cover shared observation times, plan weights, both
  windows, all four scenarios, reset discontinuities, missing/stale/expired
  data, source ambiguity, disabled/retired/unresolved accounts and privacy.
- Full verification: 1,959 tests, TypeScript and production build pass; lint has
  zero errors and six existing Fast Refresh warnings.
- Actual application shell with synthetic API fixtures, Chromium/Playwright:
  desktop 1920px, laptop 1280px and mobile 390px. Nine states pass geometry,
  target, contrast and page-error checks. Icon alignment/size, independent
  minimize/restore, provider filters, total/provider switching, account
  visibility and keyboard inspection pass. Captures were visually inspected.

These captures use synthetic data. Live checks are recorded separately and do
not claim public SSO sign-in verification.

Post-deploy verification used the deployed UI and API through authenticated
loopback access. Both modes, provider filters, rate mode, keyboard inspection,
minimize/restore and account expansion passed; all five accounts loaded and the
total matched the provider balances. No page errors or quota issues were reported.
The inference proxies and usage dashboard retained their start times. Live review
also caught dense forecast dots filling dash gaps; dense projections now use the
dashed stroke alone, keeping sparse observations visible.
