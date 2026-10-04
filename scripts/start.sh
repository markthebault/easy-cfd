#!/usr/bin/env bash
# Serve the UI and API together, bound only to this computer. Ctrl-C stops safely.
# One worker owns the simulation queue. Never add --workers or --reload here.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .easycfd/tailnet-origin ]]; then
  export EASYCFD_TAILNET_ORIGIN="$(cat .easycfd/tailnet-origin)"
fi
if [[ ! -d .venv || ! -f frontend/dist/index.html ]]; then
  ./scripts/setup.sh
fi
# The web UI (served at /) is rebuilt on each start so it matches the checkout; the original UI
# (served at /legacy/) is rebuilt when it was built for another base path.
if command -v npm >/dev/null 2>&1; then
  [[ -d web/node_modules ]] || npm --prefix web ci
  VITE_ENABLE_OPENFOAM=true npm --prefix web run build --silent >/dev/null
  if ! grep -q '/legacy/assets/' frontend/dist/index.html; then
    npm --prefix frontend run build --silent -- --base=/legacy/ >/dev/null
  fi
fi
if [[ "${1:-}" == "--open" ]]; then
  uv run python -c 'import threading, webbrowser; t=threading.Timer(3, lambda: webbrowser.open("http://127.0.0.1:8000")); t.start()' &
fi
exec uv run uvicorn easycfd.api:app --host 127.0.0.1 --port 8000
