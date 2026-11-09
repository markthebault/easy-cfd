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
exploration. No convergence or engineering-accuracy claim is made.
The ground at y=0 uses reflected body boundaries and opposite-sign image vortices.
Images are regenerated after shedding and merging, keeping the slip-wall symmetry
independent of adaptive merge ordering. Only physical bodies contribute to reported
forces. Only the physical half-plane is returned to the renderer.
The ground is impermeable, with tangential slip and no road boundary layer.
Ground hatching marks the boundary. Top/side box walls
are not simulated. Pressure overlays remain unavailable in this mode.

## Port

Pinned upstream revision: `f6419b3a9f69cee1eaf2655154439cb69dd0fea6`.
`vendor/libvvhd` is unchanged upstream source; licence `vendor/LICENSE.vvflow`.
The generator removes HDF5 save/load, adapts LAPACK return types and exposes a
merge-threshold multiplier. In ground scenes it skips target updates for image
vortices, while retaining their influence on physical targets. Lua is retained for upstream expressions. CLAPACK
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

## Playback and drag/lift

Vortex playback sends one solver step per request. At 1x, pacing reserves CPU
headroom (two measured step costs, with a 33.3 ms minimum cycle); the slider
scales the cycle interval from 0.1x to 3x. Slider changes reschedule immediately. The first two startup steps are excluded
from the steady pacing estimate. Stationary rigid bodies retain exact zero
velocity so numerical residuals cannot invalidate the boundary-matrix cache.
This preserves the numerical timestep and allows faster settings to differ even
when one solver step exceeds the old worker batch budget. Hardware and evolving
vortex counts still limit the maximum rate.

The existing Drag & lift panel uses vvflow hydrodynamic forces on scene solids
only; the extra ground body's forces are excluded. Instantaneous coefficients
are labelled during warmup; they are not saved or exported as averaged data.
After the startup window, every numerical step contributes to the original
cumulative mean and drift diagnostics. The condition key identifies vvflow,
Re, timestep, surface budget, merging density and slip-ground method, so LBM and
vvflow baselines are never treated as matching.

`ground-validation.json` is a historical test of the previous finite-ground method.
It compares the same car geometry with/without the ground, including minimum
vortex y over 400 steps and the changed solved forces. This is a boundary-behaviour check, not physical validation.
`node vvflow/check-controls.mjs` verifies actual step rates at 0.1x, 1x and 3x,
metrics, pause and backend switching in Chromium and WebKit.

`node vvflow/check-ground.mjs` checks the current image-ground method at 50, 200
and 500 steps using the MX-5 editor geometry. It checks upper-surface shedding,
underbody particle depth, downstream wake growth, finite forces, exact stationary
boundaries and scene reset.
The former finite slip-ground body produced regular underbody bands and removed
most upper-surface vortices. Screenshots at matching elapsed times caught this
failure despite the older minimum-y check passing.
