#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 vvflow/prepare.py
docker run --rm -v "$PWD:/src" -w /src emscripten/emsdk:4.0.20 bash -c 'emcmake cmake -S vvflow -B vvflow/build/wasm -DCMAKE_BUILD_TYPE=Release && cmake --build vvflow/build/wasm -j6'
cp vvflow/build/wasm/vvflow.{mjs,wasm} web/public/vvflow/
