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

## Aero parts and variant comparison (28 September 2026)

Purpose: test thin and small aero parts (rear wings, canards, splitters, vents and holes) and compare variants of them reliably.

### Scope

1. **Same grid for every variant.** Grid extent, spacing and refinement come from every part in the design, whether it is switched on or not. The car length (cells per length, flow passes) is measured the same way. Switching groups changes only the solid geometry.
2. **Forces per part and per group.** Time-averaged drag, lift and side force (pressure and friction) per part over the averaging window, summed per group by the app. Shown in the results and in Compare.
3. **Finer cells around aero parts.** Refinement zones around parts that are thin or small for the grid: bands of finer spacing along the axes in which the part is small (tensor-product grid, so a band spans the domain in the other two directions).
   - Spacing inside a zone is h / r, r from 1 (off, the default after validation) to 4, set in the Run step.
   - Per group: **Auto** (thin or small parts), **Always** or **Off**.
   - **Detail boxes**: user-defined boxes refined the same way, for features inside a larger part (holes and vents in a hood, gaps under a wing).
   - A cell budget caps the grid; if it would be exceeded, r is lowered and the run says so.
   - A part counts as thin against the spacing in its own thin direction. Parts thick enough at the refined spacing become cut-cell solids instead of zero-thickness walls.
4. **Wheels are never thin walls.** Voxelisation handles overlapping and nested shells (winding number where a ray's crossings are consistent, parity otherwise).
5. **Run extension.** One criterion decides both whether to extend a run and whether it is reported as settled; the warning states whether the maximum length was reached.
6. **Surface pressure on thin parts** is sampled at a distance scaled to the local cell size, on each side.

Out of scope: adaptive (octree) refinement, automatic detection of holes inside a single part (use a detail box).

### Acceptance criteria

1. Switching any group on or off leaves the grid axes identical (unit test).
2. Per-part forces add up to the total force within 0.5 % (bench check).
3. MX-5 with a synthetic aero kit (`validation/aero-kit`, OpenFOAM Medium references for no kit, wing only and full kit): at Medium, the browser's change in Cl and Cd from adding the wing and the full kit has the same sign as OpenFOAM's and is within ±30 % of it (±0.03 absolute for Cl changes below 0.1). Results with and without refinement are both reported.
4. The eight existing validation models do not get worse: mean |ΔCd| against OpenFOAM at Medium rises by no more than 1 point.
5. Wheels never appear in the thin-parts warning; nested-shell voxelisation has a unit test.
6. Runtime of MX-5 + kit at Medium on an M1 is reported; target within 4× the same run without refinement.

### Risks

- Refinement bands add cells across the whole domain and highly anisotropic cells far from the car; the multigrid pressure solve and local time stepping may converge more slowly.
- OpenFOAM Medium resolves the kit with its own surface refinement (at least two cells across each part's thickness) and is a reference, not ground truth.

### Status (28 September 2026)

| Criterion | Result |
|---|---|
| 1. Grid identical when groups switch | Met (unit test). |
| 2. Per-part forces add up to the total | Met: per-part ranges cover every wall cell once (unit test). Per-part forces are averaged over the same pseudo-time window as the totals. |
| 3. Kit deltas within ±30 % of OpenFOAM | **Not met.** Lift changes are 31–56 % of OpenFOAM's in both settings. Drag changes are 111–238 % with detail cells off and 59–95 % with them. The splitter cases have no reference (OpenFOAM's mesh failed its quality checks). See VALIDATION.md. |
| 4. Existing models not worse | Met with detail cells off (the default). With detail cells on, two of the three older wing cars got worse, which is why they are opt-in. |
| 5. Wheels never thin; nested shells | Met (unit tests). |
| 6. Runtime within 4× | **Not met with detail cells:** 3–6×, up to 11× when a run extends to its maximum length. Without them, run time is unchanged. |

Changes from the plan:
- **Detail cells opt-in.** Detail cells are off by default because validation did not show a gain and found regressions.
- **Wing profiles.** Closed thin parts that the refined grid can almost carry (wing profiles) are modelled as solids thickened to 1.6 local cells: a zero-thickness plate stalls early.
- **Near-wall model.** Improving wing lift further needs a near-wall model for small parts. The next step is to specify it separately.

## OpenFOAM engine in the web UI (28 September 2026)

Purpose: one UI for both solvers. WebGPU (this device) stays the default for quick work; the OpenFOAM app's backend becomes an optional **engine** for precise final checks, with the same car and conditions steps, results, animations and comparison.

### Scope

1. **Hosting.**
   - The OpenFOAM backend serves the web UI at `/`, and the old UI stays unchanged at `/legacy/`.
   - `just run-openfoam` opens the new UI with both engines, and `just run` stays static and WebGPU-only.
   - Tailscale access works as before; no new service or dependency.
2. **Engine choice** in the Run step: WebGPU (default) or OpenFOAM, the latter shown only when the backend answers `/api/health`. OpenFOAM is labelled for final checks, with its presets (Fast, Medium, Precise), cell budget and measured run times. Custom quality and detail cells are WebGPU-only.
3. **Running.**
   - **Upload:** the UI uploads the design's parts as STL in the UI's world frame into one backend project per design geometry, reused while the geometry is unchanged.
   - **Setup:** it sets the wheel roles, switches parts on and off to match the groups, maps the conditions and queues the run.
   - **Frame:** the backend recentres imported geometry, so the offset between the two frames is measured from the part bounds and applied to all sampling.
4. **Live view:** stage, iteration progress and the force history streamed from OpenFOAM's force coefficients, with the moving-average statistics. There is no 3D flow while solving (OpenFOAM writes the field at the end), and the panel says so. Cancel stops the server run.
5. **Results.** When the run completes, the UI requests:
   - **Flow field:** the finished field resampled on the same uniform grid the WebGPU viewer uses (velocity, kinematic pressure, turbulence, valid-point mask).
   - **Surface:** pressure and near-wall flow direction at the UI's own surface vertices.

   The run is saved in the browser like a WebGPU run, so results, the library, Compare, exports and every visualisation work unchanged. Runs record their engine, and Compare names the engine when it differs.
6. **Existing OpenFOAM runs** on the server can be opened from the run list. The UI imports the run's geometry as a design and its results as a run.
7. **Backend additions** go in a separate module that only reads saved solver output, like the existing plane view. The pipeline hash and saved runs are unchanged.

Out of scope: legacy-only tools in the new UI (STEP import, opening repair, merge and seal, rotate and scale: use `/legacy/`); per-group forces for OpenFOAM runs (the case records body and wheel forces only); resuming a live view after the tab was closed (the run continues on the server and can be opened from the run list).

### Acceptance criteria

1. `just run-openfoam` serves the new UI at `/` and the old UI at `/legacy/`, and both work.
2. With the backend reachable, an OpenFOAM Fast run of the sample car started from the new UI completes. Its Cd and Cl equal the backend's own record, and smoke, streamlines, slice, wake and surface pressure display.
3. The flow field and surface pressure are aligned with the car in the UI's frame (checked by the stagnation point on the nose, and a unit test of the frame offset).
4. A WebGPU and an OpenFOAM run of the same design open side by side in Compare.
5. An existing OpenFOAM run can be opened from the run list.
6. Without a backend (static hosting), the UI shows WebGPU only and says how to enable OpenFOAM.
7. Backend tests cover the new endpoints; the web unit and end-to-end tests pass.

### Status (29 September 2026)

| Criterion | Result |
|---|---|
| 1. New UI at `/`, original at `/legacy/` | Met. Both are served by the backend and checked in a browser. |
| 2. OpenFOAM run from the new UI | Met. A Fast (2 min) and a Medium run of the sample car completed. Cd and Cl equal the server records (0.5169 / 0.6064 and 0.5392 / 0.5843), and every view displays. |
| 3. Field and surface aligned | Met. The stagnation region sits on the nose, and a unit test covers the offset. The surface pressure is looked up a quarter of the way into each triangle so coarse faces show face values. |
| 4. WebGPU and OpenFOAM runs in Compare | Met. Compare names the solver difference. |
| 5. Existing server runs open | Met. An MX-5 run from the aero study opened with its recorded Cd 0.3420. |
| 6. Static hosting | Met. The engine choice is disabled and explains `just run-openfoam` (end-to-end test). |
| 7. Tests | 5 new backend tests (72 in total), 3 new web unit tests, 2 new end-to-end tests against a mocked server. |
