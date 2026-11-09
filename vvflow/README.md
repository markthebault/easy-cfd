# vvflow particle mode in the 2D workspace

Open `/?workspace=2d&animation=vortex` and choose **Animation → Vortex particles**.
For the MX-5: `/?workspace=2d&animation=vortex&profile=mx5-nc-prht`.
The existing drawing, SVG import, shape transforms, enable toggles, undo, zoom,
pan and playback controls are shared with the original 2D workspace.
The separate lab page and pressure controls have been removed. Old lab URLs
redirect into the 2D editor. Other animations retain the existing LBM solver.

Vortex particles runs actual vvflow C++ compiled to WASM, in a dedicated worker.
Only this worker runs when selected; LBM fields and forces are not combined with
vvflow particles. The current enabled scene shapes are unioned with the MIT
`polygon-clipping` library and passed as exposed surface boundaries. Enclosed
fluid holes are explicitly unsupported in this mode. Disabling all shapes
produces an empty particle view. Geometry edits restart after pointer release.

Coordinates are normalised by the scene reference length, then returned to metres
for the existing camera. Boundary segments are distributed by perimeter, targeting
320 total with at least 24 per disjoint solid. Re=40,000 based on reference length,
U=1, dt=0.005, density=2. These fixed experimental settings prioritise interactive
exploration; no convergence or engineering-accuracy claim is made. The domain is
a viewing region in free air, without a simulated road or box walls. No ground
hatching, pressure overlay or force measurements are shown in this mode.

## Port

Pinned upstream revision: `f6419b3a9f69cee1eaf2655154439cb69dd0fea6`.
`vendor/libvvhd` is unchanged upstream source; licence `vendor/LICENSE.vvflow`.
The generator removes HDF5 save/load, adapts LAPACK return types and exposes a
merge-threshold multiplier. Lua is retained for upstream expressions. CLAPACK
supplies the actual pivoted LU/inversion routines. No OpenMP threads or backend
are used. The WASM build no longer includes pressure reconstruction.

The 100,000-domain preview limit and 1 GiB memory cap remain. Historical numerical
reports in this directory refer to earlier preset experiments; their longer-time
native/WASM discrepancy remains unresolved and does not validate this mode.

## Build and verify

Requires Docker, Python 3.12+, Node. Docker is build-time only.

```sh
bash vvflow/build.sh
npm --prefix web ci
npm --prefix web run build
node scripts/serve-vvflow.mjs web/dist 5219
node vvflow/check-integration.mjs
# From web/:
node --test --test-concurrency=1 tests/flow2d-vortex.test.mjs tests/flow2d.test.mjs tests/flow2d-curves.test.mjs tests/flow2d-grid.test.mjs tests/flow2d-forces.test.mjs
```

Numerical dependencies are pinned by SHA-256. Prebuilt WASM and its loader are
checked in. See `web/public/vvflow/NOTICE.txt` and companion licences.

## Persistent Tailscale host

`python3 scripts/install-vvflow-preview.py` copies the production assets to
`~/Library/Application Support/EasyCFD-vvflow/web` and reloads the KeepAlive
LaunchAgent `local.easycfd.vvflow-preview`. The static host listens on
`127.0.0.1:5218`, served by Tailscale HTTPS port 8458. It performs no simulation.
Preserve and compare existing Tailscale routes around deployment.
Logs: `~/Library/Application Support/EasyCFD-vvflow/{stdout,stderr}.log`.
