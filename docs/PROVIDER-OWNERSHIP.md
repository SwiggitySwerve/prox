# Provider ownership and account views

The Codex runtime owns Codex credentials on port 8317. The Claude runtime owns
Claude credentials on port 8319. They have separate auth directories. Canonical
filenames and auth indices must stay unchanged when moving an account, because
the usage dashboard uses them to attribute existing history.

Prox pooled quota reads both runtimes. The detailed account and log pages use
one runtime at a time, selected by the **Management source** control. Selecting
Claude uses the same-origin `/claude` management route; selecting Codex uses
`/codex`. The control is unavailable for arbitrary external backend connections,
where those sibling routes are not known to exist. Subsequent management pages
use the selected connection; check it before starting a new login or upload.

The separate usage dashboard combines the two inventories and routes credential
operations to their discovered owner. Its configured Claude login destination
is port 8319. Duplicate names or indices across runtimes deliberately cause a
conflict instead of silently choosing an account or returning an incomplete list.
Do not suppress that check or rename credentials to work around it.

## Recovering misplaced credentials

1. Inspect both live inventories. Privately compare provider, account and
   organization identity before considering two credential files equivalent.
2. Keep private backups outside both watched auth directories. Never print or
   commit credentials, keys, upstream bodies, or account identities.
3. Compare refresh metadata and preserve the newest usable grant on the owning
   runtime, retaining its operational settings. Validate it through a quota read.
4. Retire the misplaced credential through the management **delete credential**
   endpoint. Moving or deleting its file alone is insufficient: a registration
   left in memory can persist the file again during refresh or a metadata update.
5. Validate a refresh on the owning runtime after retirement. Disabling an
   account is not a refresh drain, and an access-token check alone does not prove
   its refresh grant remains usable. Do not describe a live copy as race-free.
6. Recheck both runtime inventories, both catalogs, the usage dashboard's merged
   inventory and quotas, and Prox pools. Repeat after the ranking job runs. Read
   existing usage history without consuming the production usage queue.

## Recovery on 2026-10-27

Three Claude credentials were present on both runtimes. Their account and
organization identities matched; the misplaced copies had newer refresh
metadata. Private backups were taken, each usable grant was installed on 8319,
and the duplicates were removed through the management API. Each Claude account
passed both a quota read and an explicit refresh on 8319. After running the
ranking job, 8317 still held only two Codex credentials and 8319 only three Claude
credentials. No inference service restart was needed.

The inspected runtime can recreate a file when its credential remains registered,
but the precise operation that caused this incident was not established. The
repair retires runtime registrations as well as files. The overlap guard remains.
