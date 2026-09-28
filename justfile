# EasyCFD launchers. `just` lists the recipes.

web_port := "4173"

default:
    @just --list

# Browser version (WebGPU, no server): build and serve web/dist on 127.0.0.1
run:
    #!/usr/bin/env bash
    set -euo pipefail
    cd web
    [ -d node_modules ] || npm install
    npm run build
    if lsof -iTCP:{{web_port}} -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port {{web_port}} is already in use; stop that server first." >&2
      exit 1
    fi
    echo "EasyCFD Web: http://127.0.0.1:{{web_port}}  (Ctrl-C to stop)"
    exec python3 -m http.server {{web_port}} --bind 127.0.0.1 --directory dist

# OpenFOAM version (Docker solver): http://127.0.0.1:8000
run-openfoam:
    ./scripts/start.sh
