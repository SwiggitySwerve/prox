#!/usr/bin/env bash
# Serve a local copy of the UI, run the synthetic Auth Files capture against it, stop the server.
#   scripts/visual/auth-files-capture.sh dev   <out-dir> [case ...]   # Vite dev server
#   scripts/visual/auth-files-capture.sh build <out-dir> [case ...]   # bun run build + vite preview of dist/
#   scripts/visual/auth-files-capture.sh url=http://127.0.0.1:18318 <out-dir> [case ...]  # an existing server
# PROX_CAPTURE_WIDTHS="1440 1920 390" picks the viewport widths (default: the capture's 1440 and 390).
set -euo pipefail
cd "$(dirname "$0")/../.."
mode="$1"; out="$2"; shift 2
port="${PROX_CAPTURE_PORT:-5199}"
server=""
trap '[ -n "$server" ] && kill "$server" 2>/dev/null || true' EXIT
case "$mode" in
  dev)
    node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$port" --strictPort >/tmp/auth-files-capture-server.log 2>&1 &
    server=$!; url="http://127.0.0.1:$port";;
  build)
    bun run build >/tmp/auth-files-capture-build.log 2>&1
    node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port "$port" --strictPort >/tmp/auth-files-capture-server.log 2>&1 &
    server=$!; url="http://127.0.0.1:$port";;
  url=*) url="${mode#url=}";;
  *) echo "unknown mode: $mode" >&2; exit 2;;
esac
for _ in $(seq 1 60); do curl -sf "$url/" >/dev/null && break; sleep 0.5; done
[ "$mode" = dev ] && curl -sf "$url/src/App.tsx" >/dev/null || true
cases=()
[ "$#" -gt 0 ] && cases=(--cases "$@")
[ -n "${PROX_CAPTURE_WIDTHS:-}" ] && read -ra widths <<<"$PROX_CAPTURE_WIDTHS" && cases+=(--widths "${widths[@]}")
uv run -q --with playwright python -I -B scripts/visual/auth-files-capture.py --url "$url" --out "$out" "${cases[@]}"
