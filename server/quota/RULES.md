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

- Each enabled account contributes 100 quota points per base-plan unit of its
  subscription (`plans.ts`): one unit is the provider's $20 plan (Claude Pro,
  ChatGPT Plus), and plans count as the providers' published multiples (Claude
  Max 5x/20x; ChatGPT Pro 10x, Pro 500 25x). A window's remaining percent times
  that weight gives pool points; resets restore each account to its own capacity.
  An unknown plan counts as one unit and is shown as unknown. Points are not tokens.
- Plans come from provider responses only: Codex's usage `plan_type`, and Claude's
  OAuth profile tier, read at most every six hours. A failed plan read changes
  nothing else.
- Weekly and five-hour windows are separate. Model-scoped, monthly, dollar and
  reset-credit balances are not added to those pools.
- Missing, expired, errored or older-than-15-minute samples are unknown, not 0.
  A successful response without a general window records an explicit missing
  observation, immediately superseding that window's previous balance.
  A failed poll marks an account errored only once its latest sample is older than
  15 minutes (or it has none); one failed poll never hides a still-fresh sample.
  Recorded charts hold the last balance flat across a stretch with no reports at
  all (the point 1 ms before the next report; rates stay unknown). An account
  missing while others report is still unknown, never held.
  Collections are at least 4 minutes apart: Anthropic's usage endpoint returns 429
  to bursts. Each failed poll logs status, retry-after seconds and header names.
  Disabled/retired accounts are excluded. A failed inventory cannot look like
  an empty healthy provider. History describes the current eligible membership;
  an account joins it at its first stored sample, so adding an account never
  turns the pool's earlier history unknown.
- Burn is measured depletion per hour within matching reset cycles, excluding
  increasing balances and intervals longer than 15 minutes. At least ten
  minutes of eligible observations within the selected lookback are required.
  Drain is signed net depletion, including observed replenishment.
- Forecasts require current samples, rates and future reset timestamps for
  every eligible account. The pool forecast models fill-first routing: the sum of
  the accounts' recent burn rates, scaled by the selected scenario, is drawn from
  one account at a time, the one with quota whose window resets soonest, moving
  on when it drains. Per-account "predicted empty" still uses that account's own
  rate. Resets repeat on the reported period, restoring 100 points per plan
  unit. No future activity spike is inferred. Actual providers can change
  windows and limits; these are scenarios.
- Recorded lines break across collection gaps. No history is backfilled or
  fabricated. Refresh does not consume usage queues, mutate auth or reset limits.
- Only authenticated requests receive results. Account names/emails are omitted
  unless explicitly requested; default labels and opaque IDs are sufficient.

Regression coverage lives in `tests/proxPoolDomain.test.ts` and the collector,
store and HTTP tests; `tests/proxQuotaSources.test.ts` covers source isolation and
transactional migration with synthetic data. Samples are private local data;
never log credentials, upstream bodies or account identifiers.

The combined chart can show separate provider lines or stacked provider bands. Total
recorded values reuse the account history, plan weighting, expiry and gap rules
above on a shared observation timeline. Forecast totals add the independent
piecewise-linear provider projections at every event, preserving both sides of
reset jumps. They never transfer demand between providers or extrapolate beyond
a provider's trace. Missing constituent values remain unknown. Multiple eligible
sources for the same provider still withhold the total until allowance identity
is proven; disabled, retired and unresolved accounts add no capacity.

The server also exposes each provider's contribution on the total's exact history
and forecast event timeline. Those layer traces contain no account metadata.
The browser renders these results without quota arithmetic: stack offsets are
presentation geometry, and each band's thickness and readout retain its original
provider value. Any unknown contributor breaks all stacked bands. Signed drain
uses positive and negative stacks on opposite sides of zero. The former single
total line is replaced by these distinct layers.

Minimize controls shrink the plot and closed account roster. Account warnings
remain visible, and opening a row reveals all plan, limit and reset details. Completion polling reads dashboard status every second
while collection is running, without requesting additional collections.
