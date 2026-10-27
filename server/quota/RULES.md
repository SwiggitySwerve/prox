# Quota history and forecast ownership

This package owns recorded quota history, sample quality, pooled arithmetic and
forecasts. HTTP validates requests and serializes these results. The browser
only selects views, formats values and positions chart geometry. Provider raw
window conversion belongs to `src/domain/quotaWindows`, shared with the original
credential UI. The store owns persistence; the collector uses only public APIs.

- Production membership, origins and per-instance key files come only from the
  validated deployment manifest. A collector pins a copied source list and its
  revision for its process lifetime; applying another revision requires stopping
  it and restarting. Stopping aborts in-flight requests and prevents their
  subsequent writes.
  Each instance is inventoried once, including all supported Claude/Codex kinds.
  Other kinds never trigger adapters, downloads or inference.
- Identity and complete-inventory retirement belong to an instance/provider pair.
  Failed, incomplete or malformed inventories retire nothing in that instance;
  another instance continues independently. Issues carry their owning instance.
  History for an instance removed from the manifest remains visible, but its
  pool is incomplete while that instance is absent from configuration.
- Legacy attribution uses the explicit prior-deployment mapping in `identity.ts`.
  Additive ownership and alias tables retain the original account IDs and every
  sample tuple/foreign key; migration never prunes or changes account metadata.
  All supplied mappings commit together or roll back. Conflicting mappings,
  unknown destinations and alias collisions fail. Unmapped history stays retained
  and unresolved; scoped dashboards expose its count without assigning its quota.
  New occurrences cannot claim an old ID without its persisted ownership alias.
  The original 30-day collection retention rule remains separate from migration.
- Dashboard arithmetic runs separately for each instance/provider using the same
  source-local rules below. Equal emails, filenames or auth indices do not merge
  occurrences. Multiple same-provider sources expose unavailable combined values
  with `cross-source-combination-unverified`, never summed capacity or histories.
  No allowance identity or duplicate relationship is inferred from inventory.

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
store and HTTP tests; `tests/proxQuotaSources.test.ts` covers source isolation and
transactional migration with synthetic data. Samples are private local data;
never log credentials, upstream bodies or account identifiers.
