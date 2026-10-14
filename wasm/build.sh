#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FOAM_SOURCE="${EASYCFD_FOAM_SOURCE:-$TASK_ROOT/.wasm-build/openfoam}"
EMSDK_IMAGE=emscripten/emsdk:3.1.56@sha256:f9479effb0d095fea1c8501b57c18d13876a5e3bfebcb71f0da68a0fe49c935f
if [[ ! -f "$FOAM_SOURCE/META-INFO/api-info" ]]; then
    mkdir -p "$(dirname "$FOAM_SOURCE")"
    git clone --depth 1 --branch OpenFOAM-v2512 https://gitlab.com/openfoam/core/openfoam.git "$FOAM_SOURCE"
fi
if ! rg -q FOAM_WASM "$FOAM_SOURCE/src/OSspecific/POSIX/POSIX.C"; then
    git -C "$FOAM_SOURCE" apply "$TASK_ROOT/wasm/vendor/openfoam-wasm.patch"
fi
mkdir -p "$FOAM_SOURCE/wmake/rules/linux64Emscripten"
cp "$TASK_ROOT"/wasm/vendor/wmake-rules/{c,c++,c++Debug,c++Opt,cDebug,general} "$FOAM_SOURCE/wmake/rules/linux64Emscripten/"
cp "$TASK_ROOT/wasm/vendor/wmake-rules/emar-wrapper" "$FOAM_SOURCE/wmake/scripts/"
chmod +x "$FOAM_SOURCE/wmake/scripts/emar-wrapper"
python3 "$TASK_ROOT/wasm/prepare.py" "$FOAM_SOURCE"
docker run --rm -e JOBS="${JOBS:-8}" -v "$FOAM_SOURCE:/src/openfoam" -v "$TASK_ROOT/wasm:/src/easycfd:ro" -w /src/openfoam "$EMSDK_IMAGE" bash /src/easycfd/build-container.sh
python3 "$TASK_ROOT/wasm/package.py" "$FOAM_SOURCE" "$TASK_ROOT/web/public/openfoam"
