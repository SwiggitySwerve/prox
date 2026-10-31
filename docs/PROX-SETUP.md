# Prox iteration workspace

This is a fork of [CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center),
independent of CPA-Manager-Plus at `usage.swervelab.xyz`. Upstream is MIT licensed;
keep its license and attribution. Base commit: `64b4f5aed19b8f791eb21eb9e785ea379ea05b44`.

The upstream navigation matches the supplied Prox screenshot, including Quota
Management, Quick Start, Auth Files, Plugin Store, and Management Center Info.
Theo's exact private changes have not been obtained. The screenshot is a design
reference, not proof that upstream supplies pooled forecasts.

## Run and deploy

- Fork: `https://github.com/SwiggitySwerve/prox`
- Checkout on homelab: `/home/swerve/src/prox`
- Setup merged in PR #1; pooled dashboard branch: `feat/pooled-quota-dashboard`.
- Public UI: `https://prox.swervelab.xyz`
- Local UI: `http://127.0.0.1:18318`
- Service: `systemctl --user status prox`
- Quota history: `systemctl --user status prox-history`, loopback port 18319,
  persistent SQLite at `~/.local/share/prox-history/quota.sqlite`.
- Runtime: rootless Podman, `localhost/prox:dev`, host networking, listeners only
  on loopback and the existing cluster bridge `10.42.0.1`.

Use the Bun version pinned by `package.json` (currently 1.4.3). For local changes,
run `bun install --frozen-lockfile`, `bun run dev`, and `bun run verify`.
To publish the current working tree to this homelab preview:

```sh
bash scripts/deploy-homelab.sh
```

This verifies and builds the single-file UI and quota-history server, checks
Nginx configuration, installs their user services, and restarts only Prox and
Prox history. The script uses the pinned Bun via npm
exec, so it does not replace a machine's global Bun. Commit first when the image
revision must identify an exact source tree.

Initial routing setup (operator access on homelab):

```sh
kubectl apply -f deploy/kubernetes.yaml
bash ~/swervebox/scripts/authentik-proxy-app.sh prox.swervelab.xyz 'Prox' prox
```

The new namespace, service, EndpointSlice, and ingress are managed by this fork's
manifest for now, not by the swervebox Flux tree. Cert-manager supplies TLS;
existing wildcard DNS or external-dns supplies resolution. Authentik must be
registered before public access works. Retain the existing Authentik gate and
the proxy management-key check. Never add management keys to Git or the bundle.

## Connect to the existing providers

After Authentik sign-in, use the existing proxy management key at the UI's login:

| API address in the login form | Existing backend |
| --- | --- |
| `https://prox.swervelab.xyz` or `https://prox.swervelab.xyz/codex` | GPT/Codex, port 8317 |
| `https://prox.swervelab.xyz/claude` | Claude, port 8319 |

The checked-in source manifest, `deploy/provider-sources.json`, owns instance
membership, ports, paths, aliases, and explicit authentication-sharing scopes.
Run `bun run sources:generate` after editing it. `bun run sources:check` and the
build reject stale generated Nginx routes or public discovery. The browser reads
the sanitized `/prox/sources.json`; upstream origins and key-file references are
excluded. History collection reads the same manifest once at process start.

Each source's `providers` list says which instance takes new credentials of that
type. Every proxy accepts every provider, so OAuth logins go to the declared owner
whichever source is selected, and an auth file uploaded to another source is refused
with the owner's name. Undeclared providers stay on the selected source. Move a
misplaced credential; never copy it, because both instances would rotate one token.

These paths forward `/v8/management/` requests and the client-authenticated
`/v1/models` catalog. Management authentication passes through from the browser;
Nginx never injects it. Catalog requests use client API keys, not management keys.
No inference endpoint or catch-all backend proxy is exposed by this UI routing.

Auth Files, detailed quotas (`/quota/accounts`), provider configuration, dashboard
and installed plugins enumerate source sections. Equal filenames or account
indices remain separate occurrences. Config, OAuth, logs and system information
use an explicit source destination. Editors, confirmations, queued writes and
nested quota operations retain that destination until completion or cancellation.
Inventory refresh does not automatically run quota probes or download auth files.
An unavailable source remains visible without erasing healthy sibling results.

The `/quota` dashboard reads source-owned pools from the history service. Multiple
instances containing the same provider get separate pools; their allowances are
not added until an account-identity and combination policy can prove that sum
valid. An external, standalone management connection remains a single source.
Deployment plugin embedding is explicitly unsupported until nested asset/request
routing is verified; standalone external plugin-resource behavior is preserved.

Neither inference service, account auth directory, nor usage dashboard is changed.
No second usage-queue consumer is started. The existing queue must retain its
single consumer to avoid splitting usage history.

## Start the UI iteration here

The setup pass left `src/` unchanged. The pooled-dashboard implementation extends
it through these entry points:

- `src/features/quota/`: quota page, provider quota cards and refresh behavior.
- `src/features/quotaPool/`: combined provider pool UI and chart presentation.
- `server/quota/`: collection, persistence and forecast rules (see `RULES.md`).
- `src/domain/quotaWindows/`: existing provider parsing, shared with collection.
- `src/components/layout/`: shell and sidebar.
- `src/styles/themes.scss`: shared visual tokens.
- `src/services/api/`: v8 API boundary and provider requests.

Target: the supplied dark Prox layout, provider tabs, separate Claude/Codex pool
cards, recorded versus projected lines, burn/drain intervals, account reset
markers, and pool/first-account depletion estimates. Show stale/missing data
explicitly; projections must remain distinguishable from observations.

The quota history service collects current provider quota windows every five
minutes and retains 30 days of observations. It does not open CPA-Manager-Plus's
database or consume its queue. The service reads the existing management key
from a read-only mount, and checks that key before returning any quota data.
It never reads OAuth files or stores access tokens. Internal account metadata
and quota samples live only in the private SQLite directory. Email/name fields
are omitted from responses unless the authenticated caller explicitly reveals them.

Each enabled account contributes 100 points per base plan (Claude Pro or ChatGPT
Plus) times its plan's published multiple: Claude Max 20x = 2,000, ChatGPT Pro
200 = 1,000, Pro 500 = 2,500. Unknown plans count as 100 and are labelled.
Points are not tokens. Weekly and five-hour windows are separate.
Rates need at least ten minutes of current measured observations; until then the
view reports that it is collecting history. Forecasts assume each account keeps
its recent burn rate (or the selected multiplier) and resets on its reported
cycle. Missing/stale/error balances remain unknown, and history gaps break the
recorded line. No historical samples or plan multipliers are fabricated.

For each subsequent UI change: run `bun run verify`, deploy Prox only, and inspect
the affected route at desktop and mobile widths against the screenshot. Keep
browser screenshots free of credentials and account identities.

## Rollback

Before the first deployment of source-aware history, take a consistent SQLite
backup and retain the previous UI/history images. Stop `prox-history` before
copying its database directory (including any WAL files), or use SQLite's online
backup API while it runs. Do not copy only a live `.sqlite` file. Store backups
privately; they contain account metadata. This is an operator prerequisite, not
an automated backup in `scripts/deploy-homelab.sh`.

Source attribution adds ownership/alias tables in one transaction. The explicit
prior-deployment mapping in `server/quota/identity.ts` retains legacy account IDs
and sample tuples. Conflicts fail startup; unmapped history stays retained and is
reported as unresolved. Keep instance IDs stable when editing labels or paths.
To roll back, stop history first, restore the consistent backup and previous
images together, then restart. Never run old and new collectors concurrently.
Synthetic migration tests cover rollback, repeated startup and unknown provenance;
they do not certify the production database or replace its backup.

Stop the new UI and collector with `systemctl --user stop prox prox-history`.
Keep the data directory for later recovery. To remove its cluster
routes, run `kubectl delete -f deploy/kubernetes.yaml`. This manifest contains only
the new Prox namespace/resources. Existing proxy and usage services are untouched.
Remove the Prox Authentik application/provider separately if retiring the service.

## Setup verification (2026-10-27)

The initial upstream test run had one failure: a cooldown hint assertion compared
an unescaped apostrophe against React's escaped HTML. Shared test escaping now
handles that assertion; no application UI source changed. The pinned Bun run
passes all 1,662 tests, ESLint, TypeScript, and the production build.

The deployed Nginx configuration passes `nginx -t`; Kubernetes accepts the
manifest in a server-side dry run. The local health endpoint returns 200, while
an unauthenticated management request returns 401. The new TLS certificate is
ready and public requests redirect to Authentik.

Chromium checks at 1440×1000 and 390×844 loaded the quota page and refreshed all
two Codex and three Claude quotas through their respective routes. Public SSO
redirect was checked in Chromium, but a complete public Authentik sign-in was
not performed. Local authenticated checks exercised the same deployed UI and
Nginx API routes. Screenshots were redacted before capture.

T3 preview is blocked by this host's AppArmor sandbox configuration. The fallback
used an isolated headless Chromium profile, closed after verification. Chromium
and its missing libcups, libcairo, and libpango runtime libraries were installed
for those checks. The original inference and usage container start times are
unchanged. This records the setup baseline before the pooled dashboard.

## Pooled dashboard verification (2026-10-27)

The full verification passes 1,716 tests, ESLint, both TypeScript configurations,
and the single-file frontend plus Bun server build. The deployed history API
loads all three Claude and two Codex accounts with no collection issues, through
each of the root, `/codex`, and `/claude` management routes.

Authenticated Chromium checks passed provider filters, rate modes, quota-window
and usage-scenario controls, privacy toggling, and all five account rows.
Desktop (1440×1100) and mobile (390×844) have no page overflow or browser errors.
Initial live charts correctly show collection in progress; forecasts require
real observation history. A full public Authentik sign-in remains unverified.

Independent review found a fractional-timestamp depletion loop that returned
HTTP 503 for valid quota observations. Depletion events now set the balance to
zero exactly; regression tests cover the reported HTTP failure and sub-millisecond
depletion. Missing-window observations also suppress rates immediately. The
reviewer's original reproducer now returns HTTP 200.

Remote CI was unavailable for the setup merge; these verification results are
local checks. Inference and CPA-Manager-Plus container start timestamps remain
unchanged from before the Prox work.
# Analytics

The Observe sidebar's **Analytics** page reads retained request events from CPA
Manager. It includes Overview, Tokens & Cache, Cost, Performance, Requests and
Model Rates. Filters and chart drilldowns share the same server-side query; request
pages use stable timestamp/ID cursors. The request inspector shows an allowlisted
projection, never raw request bodies, headers or credential files.

`deploy/provider-sources.json` explicitly grants the history management key access
to the complete `homelab` CPA dataset. The `analytics` entry fixes the CPA origin
and references `/run/secrets/cpa-admin-key`. Install the existing CPA admin key
privately at `~/.config/prox/cpa-admin-key` with mode 0600; the history container
mounts it read-only. This credential is separate from proxy management and client
inference keys and is never sent to the browser. This grant is for the trusted
homelab administrator, not for tenants with different data permissions.

The existing `/v8/management/prox/analytics` route reaches the authenticated Prox
server, which calls CPA's dedicated `/v0/management/monitoring/prox-analytics`
endpoint. This is the CPA server's contract, not a fallback to an older proxy API.
The inference instances remain on v8. CPA remains the sole usage queue consumer.
Registered model lists are read independently from every configured source using
that source's client key. Source failures remain visible in the rate table.

Prices are **equivalent API estimates at the currently configured rates**, not
subscription bills or historical invoice prices. Unpriced models and incomplete
measurements remain explicitly unavailable. Retained events do not establish
coverage of every inbound request: old missing-usage records, pre-admission failures
and queue/process losses cannot be reconstructed. Timing methods are displayed;
full-duration output rate must not be presented as pure generation speed.
