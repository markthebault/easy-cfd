# vvflow browser experiment

Open `/?workspace=vvflow` or choose **vvflow lab** in the workspace menu.
This is an additional experimental page; the existing 2D solver remains available.
All computation runs in the visiting browser. The host only serves static files.

## Scope

- Actual upstream C++ viscous vortex domains core compiled to WASM, single-threaded.
- Cylinder, NACA-0012, prescribed moving-spoiler and MX-5 NC PRHT presets.
- Signed circulation particles rendered with WebGL 2; no synthetic wake forces.
- Pan/zoom, near/full wake, light/dark, particle size, pause, single step and reset.
- Reynolds number, surface panels, timestep, angle of attack and sampled force CSV.
- Each reset terminates its worker and creates a new instance.
- Stops at t*=40 or 100,000 vortices. WASM memory capped at 1 GiB.

No editor/SVG import, moving ground, performance comparison
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

## MX-5 NC PRHT

Choose **MX-5 NC**, or open `/?workspace=vvflow&profile=mx5-nc`. This reuses
the existing Bézier preset from `web/src/flow2d/presets/mx5NcPrht.ts` via
`node vvflow/generate-mx5.mjs`. Its sampled curve is normalised by the 4 m
reference length, then uniformly resampled to the requested surface segment
count. The preset's 150 mm vertical offset is retained; there is no ground
boundary. The body is the supplied illustrative silhouette, not a measured
vehicle section. Reynolds number is based on car length.

## Vortex density and static pressure

Ultra dense is now the browser default (density level 6, roughly three times
the domains of the previous Dense default at level 2). Standard retains upstream merging criteria;
Dense, Extra dense and Ultra dense divide the distance-based merge threshold by
4, 16 and 36 respectively.
They retain more actual computed domains, not duplicate display dots. Counts
vary with flow state. The original opposite-sign neighbour merge rule remains.
This changes numerical resolution and cost and does not establish convergence.
`prepare.py` generates `MEpsilonFast.cpp` with this one threshold multiplier.

View offers Particles, Pressure, and Pressure + particles. Static pressure uses
upstream `XPressure` with static reference frame `s`. It includes unsteady vortex
and boundary contributions, rather than a speed-only Bernoulli approximation.
The adapter recomputes boundary circulations on a deep copy at the current state
time, then reconstructs pressure without advancing or changing the live solver.
The temporary pressure tree is released by a generated RAII destructor.

Cp = 2 (p-p_infinity)/(rho U_infinity^2). Body interiors and non-finite values
are masked. The fixed blue-to-red display range is -2.5 to +2.5; raw samples
remain unclipped. This is a coarse sampled experimental field with potential
near-vortex singularities, not a validated surface-pressure measurement.
Pressure targets 10 refreshes per wall-clock second (100 ms), and once immediately
on pause/view changes; its sample time is shown. Sampling follows the viewport
with square spacing, up to 144 x 128 samples. Horizontal display resolution
adapts between 56 and 144 samples to reserve CPU time for 10 FPS; this does not
change vortex resolution. Pausing restores the full pressure display grid.
Pan/zoom resamples the field.

Tests: `node vvflow/check-pressure.mjs` (native image required) and
`node vvflow/check-pressure-browser.mjs` (static test host on port 5219, or
set VVFLOW_URL). The first checks native Cp agreement, body masks, exact live
state and next-step invariance, and increasing vortex counts.

Solver batches end near the next pressure deadline. If reconstruction plus a
solver step costs more than 100 ms, actual refresh remains below 10 FPS.

For stationary geometry, pressure reuses the upstream inverse-matrix cache.
The copied state and solution bindings are refreshed every sample; changed
matrices retain upstream hash invalidation and moving bodies use the upstream
direct solve. This avoids repeating matrix inversion at every pressure frame.
