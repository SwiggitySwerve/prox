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
- Setup branch: `setup/prox-workspace`
- Public UI: `https://prox.swervelab.xyz`
- Local UI: `http://127.0.0.1:18318`
- Service: `systemctl --user status prox`
- Runtime: rootless Podman, `localhost/prox:dev`, host networking, listeners only
  on loopback and the existing cluster bridge `10.42.0.1`.

Use the Bun version pinned by `package.json` (currently 1.4.3). For local changes,
run `bun install --frozen-lockfile`, `bun run dev`, and `bun run verify`.
To publish the current working tree to this homelab preview:

```sh
bash scripts/deploy-homelab.sh
```

This verifies and builds the single-file UI, checks Nginx configuration, installs
the user service, and restarts only Prox. The script uses the pinned Bun via npm
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

These paths forward only `/v8/management/` requests. Management authentication is
passed through from the browser, never injected by Nginx. This initial upstream
UI connects to one instance at a time. A combined account view is future work.
Backend-declared plugin/custom-extension paths need explicit routing before use;
the setup does not expose a catch-all backend proxy or inference endpoint.

Neither inference service, account auth directory, nor usage dashboard is changed.
No second usage-queue consumer is started. The existing queue must retain its
single consumer to avoid splitting usage history.

## Start the UI iteration here

The setup pass intentionally leaves `src/` unchanged. Entry points:

- `src/features/quota/`: quota page, provider quota cards and refresh behavior.
- `src/components/layout/`: shell and sidebar.
- `src/styles/themes.scss`: shared visual tokens.
- `src/services/api/`: v8 API boundary and provider requests.

Target: the supplied dark Prox layout, provider tabs, separate Claude/Codex pool
cards, recorded versus projected lines, burn/drain intervals, account reset
markers, and pool/first-account depletion estimates. Show stale/missing data
explicitly; projections must remain distinguishable from observations.

Before adding the chart, establish a single server-side quota-history and
forecasting owner. Preserve provider and quota-window boundaries; percentages
across plans are not interchangeable token capacities. Pool weights need an
explicit supported rule. Inspect existing stored quota snapshots through their
public contract instead of opening CPA-Manager-Plus's database from the frontend.
Do not start inference traffic, fabricate historical quota samples, or change
production routing to make a chart appear populated.

For each subsequent UI change: run `bun run verify`, deploy Prox only, and inspect
the affected route at desktop and mobile widths against the screenshot. Keep
browser screenshots free of credentials and account identities.

## Rollback

Stop just the new UI with `systemctl --user stop prox`. To remove its cluster
routes, run `kubectl delete -f deploy/kubernetes.yaml`. This manifest contains only
the new Prox namespace/resources. Existing proxy and usage services are untouched.
Remove the Prox Authentik application/provider separately if retiring the service.
