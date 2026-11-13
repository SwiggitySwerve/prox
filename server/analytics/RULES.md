# Analytics transport ownership

prox-usage's query owners (`server/usage/`) calculate tokens, money, rates,
distributions and request projections. This package only authenticates the
deployment's explicit `homelab` dataset grant, enumerates registered source catalogs
and transports a bounded query to the fixed prox-usage analytics endpoint
(`manifest.analytics.upstreamOrigin`, loopback port 18320). It never consumes usage
queues, reads auth files, persists events or calculates prices in the browser.

The history management key grants access to the complete retained usage dataset,
including safe operational metadata. Source selection is not an account-level
authorization boundary. This is a single-administrator homelab deployment; do not
reuse this grant for untrusted or tenant-scoped credentials.

The bridge sends that same management key (`analytics.adminKeyFile` names the
already-mounted `/run/secrets/proxy-management-key`; prox-usage checks the bearer
against the same file). No second credential is mounted. prox-usage stays
loopback-only, reached over the host network. No caller supplies a destination,
credential, catalog or response include list. Redirects are rejected; request/response
bytes, request duration and catalog size are bounded. Upstream errors never echo
payloads. The path is still `/v0/management/monitoring/prox-analytics`, an alias
prox-usage keeps so the origin and key are the only values that differ from the
retired CPA-Manager-Plus source (rollback: `docs/PROX-SETUP.md`, Analytics).

Catalog membership comes from each configured source using its own management
key to read its client key inventory, then a client key to read `/v1/models`.
Publisher names come from that catalog; they are not inferred from model names.
A failed source appears unavailable, not empty. Catalogs and historical usage
remain distinct; prox-usage resolves current configured prices and labels unknowns.

`cache.ts` keeps the last good response per view in memory only, so a page load
never waits on a multi-second scan. A live window (ending near now) is keyed by
span or UTC-midnight start plus filters, not by the caller's clock; cursor pages and
fixed windows are keyed exactly. A stale view is served at once and recomputed behind
the request; a warmer refreshes the default views (most used first, at most two
queries at a time) and any live view asked for in the last 24 hours, so a remembered
filter or provider opens warm too. At most 64 views are held. When no view has been asked
for in 15 minutes (or, for a live view, since it was last asked for), it refreshes once
every 30 minutes, and a kept view is answered from its last snapshot up to 90 minutes old,
refreshing behind the visit. The registered catalog is read and shared by every view for
5 minutes, only when every source answered. A snapshot computed while a source's catalog
was unavailable never replaces one where every source was ready; it is retried sooner.
A failure is never cached and never replaces a good snapshot. The
response's own `generated_at_ms` and window stay authoritative, so snapshot age is
visible. `Cache-Control: no-cache` (the page's Refresh) forces a recompute.

Retained events cannot establish all-ingress completeness. Pre-admission failures,
process loss and old missing-usage paths may be absent. Coverage and timing
limitations must remain visible; API-equivalent estimates are not billed totals.
