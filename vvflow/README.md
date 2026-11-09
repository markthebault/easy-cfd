# vvflow browser experiment

Open `/?workspace=vvflow` or choose **vvflow lab** in the workspace menu.
This is an additional experimental page; the existing 2D solver remains available.
All computation runs in the visiting browser. The host only serves static files.

## Scope

- Actual upstream C++ viscous vortex domains core compiled to WASM, single-threaded.
- Cylinder, NACA-0012 and prescribed moving-spoiler presets.
- Signed circulation particles rendered with WebGL 2; no synthetic wake forces.
- Pan/zoom, near/full wake, light/dark, particle size, pause, single step and reset.
- Reynolds number, surface panels, timestep, angle of attack and sampled force CSV.
- Each reset terminates its worker and creates a new instance.
- Stops at t*=40 or 100,000 vortices. WASM memory capped at 1 GiB.

No editor/SVG import, moving ground, pressure-field view, performance comparison
against LBM, grid/time convergence or physical validation is included yet.
The two solvers have different flow conditions; do not compare their displayed
loads as a matched benchmark. Browser CPU computes the flow; GPU draws particles.

## Upstream and port boundary

Pinned vvflow revision: `f6419b3a9f69cee1eaf2655154439cb69dd0fea6`.
`vendor/libvvhd` is an unchanged snapshot of the upstream library. MIT licence in
`vendor/LICENSE.vvflow`. See `web/public/vvflow/NOTICE.txt` and the companion licences.

`prepare.py` generates a TSpace translation unit without HDF5 save/load and a
TMatrix translation unit with int-return CLAPACK declarations. Neither changes
numerical equations. `browser.cpp` follows the upstream CLI's `simulate()` step
order, omitting file output, monitoring sockets and sensor output. Lua 5.2.4 is
retained for time-dependent expressions. CLAPACK 3.2.1 supplies pivoted LU and
matrix inversion; a small bridge supplies row-major DGEMV, f2c string helpers and
the IEEE binary64 safe-minimum query. Native builds link system BLAS/LAPACK.
OpenMP directives are ignored in this first port. No pthread or COOP/COEP needed.

## Rebuild

Requires Docker, Python 3.12+ and Node. Docker is a build-time tool only.

```sh
bash vvflow/build.sh
npm --prefix web ci
npm --prefix web run build
```

Downloads are pinned by SHA-256. `web/public/vvflow/vvflow.mjs` and `.wasm` are
checked in so a frontend build needs no C++ compiler or Docker runtime.

```sh
bash vvflow/native.sh
node vvflow/validate.mjs
node scripts/serve-vvflow.mjs web/dist 5218
# In another terminal:
node vvflow/check-browser.mjs
```

`validation.json` compares the native **adapter** with system LAPACK against the
WASM adapter with CLAPACK. It does not compare the unmodified upstream CLI.
Short-time checks pass; the longer moving-spoiler comparison is a characterization
with an unresolved discrepancy, explicitly recorded as outside tolerance. The
validation command does not convert that result into a passing parity claim.
Adaptive merging/tree ordering and native/WASM floating-point differences need
investigation. This is not ready to replace the current solver on accuracy grounds.

## Display and force conventions

U=1, rho=1, cylinder diameter/airfoil chord Lref=1. Re=1/nu in those units.
Positive angle of attack rotates the airfoil nose upward (clockwise with +x flow).
The standalone spoiler plate opens 60 degrees relative to its initial orientation
at t*=5..7 and retracts at t*=15..17. It has finite thickness and a small clearance;
it is not the exact video's geometry or operating condition.

Cx=2 Fx, Cy=2 Fy, Cm=2 M about the global origin, summed over bodies. Forces are
sampled before the move; particle/body snapshots follow the move. CSV uses the
force sample time, while the main clock shows the state time (one dt later).
The chart/CSV sample once per worker batch, not every numerical step. Initial
impulsive-start loads are included. No settled mean or uncertainty bound is shown.

Particle centres and signed circulations are solver output. Red is positive
(counterclockwise), blue negative. Dot size, softness and per-frame opacity
normalization are illustrative, not quantitative vorticity or core-radius maps.

## Persistent Tailscale preview

```sh
python3 scripts/install-vvflow-preview.py
```

Copies production assets to `~/Library/Application Support/EasyCFD-vvflow/web`,
installs `local.easycfd.vvflow-preview` as a KeepAlive LaunchAgent, and adds only
Tailscale HTTPS port 8458 pointing to the static host on `127.0.0.1:5218`.
Inspect and save `tailscale serve status --json` before/after installation.

URL: `https://marks-mac-mini.baboon-trench.ts.net:8458/?workspace=vvflow`
Logs: `~/Library/Application Support/EasyCFD-vvflow/{stdout,stderr}.log`.
Cases are presets only; no solver data is uploaded or stored on the host.
