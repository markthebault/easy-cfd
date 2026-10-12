#!/usr/bin/env bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq m4 flex libfl-dev > /dev/null
cp -n /usr/include/FlexLexer.h "$EMSDK/upstream/emscripten/cache/sysroot/include/" || true
source /src/easycfd/build-env.sh
mkdir -p "$FOAM_APPBIN" "$FOAM_LIBBIN/dummy" "$WMAKE_BIN"
test -x "$WMAKE_BIN/wmkdepend" || g++ -std=c++11 -O2 -o "$WMAKE_BIN/wmkdepend" "$WM_DIR/src/wmkdepend.cc"
test -x "$WMAKE_BIN/lemon" || gcc -O2 -o "$WMAKE_BIN/lemon" "$WM_DIR/src/lemon.c"
cd "$WM_PROJECT_DIR"
wmakeLnIncludeAll -update -silent src
for lib in Pstream/dummy OSspecific/POSIX OpenFOAM fileFormats surfMesh meshTools finiteVolume mesh/blockMesh mesh/extrudeModel dynamicMesh \
    lagrangian/basic sampling parallel/decompose/decompositionMethods parallel/distributed parallel/decompose/decompose parallel/reconstruct/reconstruct \
    mesh/snappyHexMesh transportModels/twoPhaseMixture transportModels/incompressible TurbulenceModels/turbulenceModels TurbulenceModels/incompressible; do
    echo "Building $lib"
    cd "$FOAM_SRC/$lib"
    wmake -j"${JOBS:-8}" libso
done
pids=()
for application in utilities/mesh/generation/blockMesh utilities/mesh/generation/snappyHexMesh solvers/incompressible/browserFoam utilities/mesh/manipulation/checkMesh; do
    echo "Building $application"
    (cd "$FOAM_APP/$application"; wmake -j2) &
    pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
exit "$status"
