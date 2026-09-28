# EasyCFD Web — specification

A browser-only virtual wind tunnel. No OpenFOAM, no Docker, no server. The flow is computed on the visitor's GPU through WebGPU; the page is static files.

## Scope

- Import car geometry (STL binary/ASCII, OBJ, glTF/GLB), choose units and axes, mark wheels, switch parts on and off. Built-in sample car and optional rear wing (same dimensions as the OpenFOAM app's sample).
- Driving conditions matching the OpenFOAM app: road speed 5–300 km/h, yaw −20…20°, reference area, air density, moving ground, rotating wheels, automatic or custom tunnel box.
- Quality presets Fast / Medium / Precise, plus Custom (mesh level + iteration budget).
- Steady incompressible RANS, k-ω SST, same boundary-condition types as the OpenFOAM case (fixed-velocity inlet, fixed-pressure outlet, freestream sides, symmetry top, moving-wall ground, rotating wheels, wall functions).
- Results: Cd, Cl, drag N, downforce/lift N and kg, body/wheel and pressure/viscous breakdown, force history, convergence status.
- Visualisation: surface pressure, animated smoke particles, streamlines from a movable rake, section plane (speed, pressure, total pressure, turbulence), wake iso-surface of total-pressure loss, live view while solving.
- Designs saved in the browser (IndexedDB); side-by-side comparison with synchronised cameras.

Out of scope for this version: STEP import, geometry repair/merge/seal tools, transient LES, heat transfer, internal flow.

## Numerical method (decisions)

| Topic | Choice | Reason |
|---|---|---|
| Grid | Stretched tensor-product Cartesian, staggered (MAC) velocities | No meshing step; GPU-friendly; checkerboard-free |
| Geometry | Voxelised solid mask (3-axis ray parity vote) | Robust for slightly leaky STL; no snapping |
| Time marching | Pseudo-transient fractional step to steady state; forces averaged over the final window | Explicit kernels map to WebGPU compute |
| Pressure | Geometric multigrid V-cycles (red-black Gauss-Seidel) | O(N), no global matrix |
| Convection | Bounded second-order upwind (U), first-order upwind (k, ω) | Same as `linearUpwindV` / `upwind` in the OpenFOAM case |
| Turbulence | k-ω SST (Menter 2003, OpenFOAM coefficients) with k-based wall functions | Same model as the reference |
| Forces | Pressure + wall-function shear summed over fluid/solid faces | Gives pressure/viscous and per-part breakdown |

## Acceptance criteria

1. The app loads from static files and runs a simulation with the network disconnected after first load. No request leaves the browser.
2. On WebGPU-capable browsers a Fast run of the sample car completes in under 2 minutes on an Apple M1.
3. Drag coefficient within ±10 % of the OpenFOAM reference for every validation model in `validation/models.json` (sample car, sample car + wing, MX-5 NC, BMW Z4, Ahmed 25°). Lift is reported against the same references; where the reference |Cl| < 0.1 the comparison uses an absolute tolerance of 0.05 because a relative tolerance is meaningless near zero.
4. Validation runs are reproducible from one command and recorded in `web/VALIDATION.md` with the actual numbers, including any model that misses the target.
5. The browser never displays synthetic or placeholder flow data. When WebGPU is unavailable, the app says so and does not fake a result.

## Risks

- Staircase walls on a Cartesian grid can move separation on smooth bodies; lift is more sensitive than drag.
- The OpenFOAM references themselves vary between mesh levels (MX-5 Cl: −0.04 Fast, 0.23 Medium). Medium is used as the reference where available.
- WebGPU availability: Chrome/Edge 113+, Safari 26+, Firefox 141+ (Windows). Older browsers are told to upgrade.

## Status (26 September 2026)

| Criterion | Result |
|---|---|
| 1. Static, offline, no requests | Met. Production build is 1.2 MB of static files with a strict CSP; no runtime network access. |
| 2. Fast sample-car run under 2 min on an M1 | Met: about 50 s. |
| 3. Drag within ±10 % of OpenFOAM on every model | **Not met for all.** Fast 6 of 8, Medium 5 of 8, Precise 5 of 8; all within 16 %. Lift misses by 0.2–0.3 on four models. See VALIDATION.md. |
| 4. Reproducible validation | Met: `node validation/run-validation.mjs`, results in `validation/results/final-*.json`. |
| 5. No synthetic data; WebGPU missing is reported | Met. |

Changes from the original plan: cut cells replaced the voxel staircase; local time stepping replaced time-accurate marching; Precise averages two grid levels.
