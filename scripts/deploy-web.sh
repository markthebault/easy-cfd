#!/usr/bin/env bash
# Publish only static browser assets. Credentials are loaded after the build.
set -euo pipefail
set +x
cd "$(dirname "$0")/.."
[[ -d web/node_modules ]] || npm --prefix web ci
VITE_ENABLE_OPENFOAM=false npm --prefix web run build:webgpu

set -a
source "${EASYCFD_CLOUDFLARE_ENV:-$HOME/.env.cloudflare}"
set +a
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-${CLOUDFLARE_TOKEN:-${CF_TOKEN:-}}}}"
: "${CLOUDFLARE_API_TOKEN:?Cloudflare API token is required}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-c2e07154ac9eb2d292307bb4c2f244ef}"
cd web
npx --yes wrangler@4.147.0 pages deploy dist-webgpu --project-name easy-cfd --branch main --commit-dirty=true
