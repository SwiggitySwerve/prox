# Combined quota graph and compact views

The combined graph renders each source/provider on a shared time and point scale. It does not sum balances or infer additional capacity. It reuses the provider chart renderer, preserving null gaps, recorded/forecast styling, rate modes, privacy, and saved-data labels. Every graph can shrink to 160px and return to its original height without hiding accounts or changing data.

Refresh completion reads the existing dashboard once per second while the server reports collection in progress, then returns to normal 15-second polling. It never starts extra collections. Failures back off; disposal and session changes stop reads.

Validation: 1,950 tests passed, type checks and production build passed; lint has zero errors and six existing Fast Refresh warnings. Tests cover shared scale without summed capacity, separate same-provider source histories, null gaps, rate mode, compact scale, collection completion, slow reads, failures, session invalidation, and disposal.

Browser captures use synthetic API fixtures in the actual application shell, Chromium 156 via Playwright, at 1920px, 1280px and 390px. Summary and measurements record thirteen data/layout states. Independent minimize/restore, provider filters, account expansion, ordering, keyboard inspection, and retained quota alignment pass. No horizontal overflow, clipped text, measured contrast/target failures, or page errors were recorded. The synthetic 2.5-second collection clears the refresh indicator in 3.5 seconds with exactly one collection request.

`wide.png` and `wide-minimized.png` show normal and minimized desktop views. `narrow.png` and `narrow-minimized.png` show both mobile views. Other state captures remain alongside the measurements. These are synthetic checks, not public SSO verification.
