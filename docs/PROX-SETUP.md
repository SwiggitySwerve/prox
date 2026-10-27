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

These paths forward `/v8/management/` requests. Management authentication is
passed through from the browser, never injected by Nginx. The original account
management pages connect to one instance at a time. The new `/quota` dashboard
uses `/v8/management/prox/` to read both providers through the history service;
the original single-instance quota view remains at `/quota/accounts`.
Backend-declared plugin/custom-extension paths need explicit routing before use;
the setup does not expose a catch-all backend proxy or inference endpoint.

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

Each enabled account contributes 100 normalized points; different plans are not
treated as equal token capacities. Weekly and five-hour windows are separate.
Rates need at least ten minutes of current measured observations; until then the
view reports that it is collecting history. Forecasts assume each account keeps
its recent burn rate (or the selected multiplier) and resets on its reported
cycle. Missing/stale/error balances remain unknown, and history gaps break the
recorded line. No historical samples or plan multipliers are fabricated.

For each subsequent UI change: run `bun run verify`, deploy Prox only, and inspect
the affected route at desktop and mobile widths against the screenshot. Keep
browser screenshots free of credentials and account identities.

## Rollback

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

The full verification passes 1,714 tests, ESLint, both TypeScript configurations,
and the single-file frontend plus Bun server build. The deployed history API
loads all three Claude and two Codex accounts with no collection issues, through
each of the root, `/codex`, and `/claude` management routes.

Authenticated Chromium checks passed provider filters, rate modes, quota-window
and usage-scenario controls, privacy toggling, and all five account rows.
Desktop (1440×1100) and mobile (390×844) have no page overflow or browser errors.
Initial live charts correctly show collection in progress; forecasts require
real observation history. A full public Authentik sign-in remains unverified.
