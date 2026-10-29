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

Retained events cannot establish all-ingress completeness. Pre-admission failures,
process loss and old missing-usage paths may be absent. Coverage and timing
limitations must remain visible; API-equivalent estimates are not billed totals.
