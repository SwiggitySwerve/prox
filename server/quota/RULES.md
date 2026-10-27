# Quota history and forecast ownership

This package owns recorded quota history, sample quality, pooled arithmetic and
forecasts. HTTP validates requests and serializes these results. The browser
only selects views, formats values and positions chart geometry. Provider raw
window conversion belongs to `src/domain/quotaWindows`, shared with the original
credential UI. The store owns persistence; the collector uses only public APIs.

- Each enabled account contributes 100 normalized quota points, regardless of
  plan. This is not token capacity or a claim of equal subscription budgets.
- Weekly and five-hour windows are separate. Model-scoped, monthly, dollar and
  reset-credit balances are not added to those pools.
- Missing, expired, errored or older-than-15-minute samples are unknown, not 0.
  A successful response without a general window records an explicit missing
  observation, immediately superseding that window's previous balance.
  Disabled/retired accounts are excluded. A failed inventory cannot look like
  an empty healthy provider. History describes the current eligible membership.
- Burn is measured depletion per hour within matching reset cycles, excluding
  increasing balances and intervals longer than 15 minutes. At least ten
  minutes of eligible observations within the selected lookback are required.
  Drain is signed net depletion, including observed replenishment.
- Forecasts require current samples, rates and future reset timestamps for
  every eligible account. Each account keeps its own recent burn rate, scaled by
  the selected scenario. Resets repeat on the reported period, restoring 100
  points. No load redistribution, future activity spike or plan weighting is
  inferred. Actual providers can change windows and limits; these are scenarios.
- Recorded lines break across collection gaps. No history is backfilled or
  fabricated. Refresh does not consume usage queues, mutate auth or reset limits.
- Only authenticated requests receive results. Account names/emails are omitted
  unless explicitly requested; default labels and opaque IDs are sufficient.

Regression coverage lives in `tests/proxPoolDomain.test.ts` and the collector,
store and HTTP tests. Samples are private local data; never log credentials,
upstream bodies or account identifiers.
