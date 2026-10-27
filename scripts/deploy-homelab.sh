#!/usr/bin/env bash
# Build and install Prox UI and quota history. Never restart either inference proxy.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
package_manager=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).packageManager")
npm exec --yes --package="$package_manager" -- bun install --frozen-lockfile
npm exec --yes --package="$package_manager" -- bun run verify
revision=$(git rev-parse HEAD)
podman build -f deploy/Dockerfile --label "org.opencontainers.image.revision=$revision" -t localhost/prox:dev .
podman run --rm --network host --entrypoint nginx localhost/prox:dev -t
podman build -f deploy/Dockerfile.history --label "org.opencontainers.image.revision=$revision" -t localhost/prox-history:dev .
install -d -m 700 "$HOME/.local/share/prox-history"
install -D -m 644 deploy/prox-history.container "$HOME/.config/containers/systemd/prox-history.container"
install -D -m 644 deploy/prox.container "$HOME/.config/containers/systemd/prox.container"
systemctl --user daemon-reload
systemctl --user restart prox-history.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  --max-time 5 http://127.0.0.1:18319/healthz
systemctl --user restart prox.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  --max-time 5 http://127.0.0.1:18318/healthz
echo 'Prox UI deployed. Cluster routing and Authentik registration are separate; see docs/PROX-SETUP.md.'
