#!/usr/bin/env bash
# Runs the Playwright suite (ui/tests/e2e) inside the official, version-pinned Playwright image, so screenshots are
# rendered by the same Chromium, fonts and OS libraries on every machine. The committed baselines were generated this way.
#
#   scripts/e2e-container.sh                       compare against the committed baselines
#   scripts/e2e-container.sh --update-snapshots    regenerate them (review the PNG diff before committing)
#   scripts/e2e-container.sh visual                any other playwright arguments pass through
#
# Needs docker or podman, plus `npm run build` (repo root) and `npm run ui:build` first: the server inside the container
# is the real `ghostwriter serve` serving ui/dist. Nothing is installed from the network at run time except the image.
set -euo pipefail

UI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$UI/.." && pwd)"

RUNTIME="${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker; elif command -v podman >/dev/null 2>&1; then RUNTIME=podman; else
    echo "e2e-container: neither docker nor podman is installed" >&2
    exit 2
  fi
fi
[ -f "$ROOT/dist/src/cli/bin.js" ] || { echo "e2e-container: run 'npm run build' at the repo root first" >&2; exit 2; }
[ -f "$UI/dist/index.html" ] || { echo "e2e-container: run 'npm run ui:build' first" >&2; exit 2; }

PW_VERSION="$(node -p "require('$UI/node_modules/@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

exec "$RUNTIME" run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 \
  -v "$ROOT:/work" -w /work/ui \
  "$IMAGE" npx playwright test "$@"
