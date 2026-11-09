#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 vvflow/prepare.py
docker build -f vvflow/Dockerfile.native -t easycfd-vvflow-native:local vvflow
docker run --rm -v "$PWD:/src" -w /src easycfd-vvflow-native:local bash -c 'cmake -S vvflow -B vvflow/build/native -DCMAKE_BUILD_TYPE=Release && cmake --build vvflow/build/native -j6'
