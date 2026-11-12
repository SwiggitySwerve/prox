# Analytics transport ownership

CPA's monitoring and pricing owners calculate tokens, money, rates, distributions
and request projections. This package only authenticates the deployment's explicit
`homelab` dataset grant, enumerates registered source catalogs and transports a
bounded query to the fixed CPA analytics endpoint. It never consumes usage queues,
reads auth files, persists events or calculates prices in the browser.

The history management key grants access to the complete configured CPA dataset,
including safe operational metadata. Source selection is not an account-level
authorization boundary. This is a single-administrator homelab deployment; do not
reuse this grant for untrusted or tenant-scoped credentials.

The CPA admin key remains in a server-only file separate from source management
keys and client inference keys. No caller supplies a destination, credential,
catalog or response include list. Redirects are rejected; request/response bytes,
request duration and catalog size are bounded. Upstream errors never echo payloads.

Catalog membership comes from each configured source using its own management
key to read its client key inventory, then a client key to read `/v1/models`.
Publisher names come from that catalog; they are not inferred from model names.
A failed source appears unavailable, not empty. Catalogs and historical usage
remain distinct; CPA resolves current configured prices and labels unknowns.

`cache.ts` keeps the last good CPA response per view in memory only, so a page load
never waits on CPA's multi-second scans. A live window (ending near now) is keyed by
span or UTC-midnight start plus filters, not by the caller's clock; cursor pages and
fixed windows are keyed exactly. A stale view is served at once and recomputed behind
the request; a warmer refreshes the default views (most used first, at most two CPA
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
