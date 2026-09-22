#!/usr/bin/env bash
# Install project dependencies and fetch the pinned, multi-architecture solver.
# The container runtime must already be running. This does not alter its settings.
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in uv npm docker; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. See README.md for prerequisites."
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "Start Colima or your Docker-compatible runtime, then run setup again."
  exit 1
fi
uv sync --locked --python 3.12
npm --prefix frontend ci
npm --prefix frontend run build
solver_image=$(uv run python -c 'from easycfd.foam import IMAGE; print(IMAGE)')
docker pull "$solver_image"
echo "Setup complete. Start with ./scripts/start.sh and open http://127.0.0.1:8000"
