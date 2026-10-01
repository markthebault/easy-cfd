# Aerodynamic analysis: implementation and evidence

1 October 2026. **Software features delivered; numerical qualification remains open.** Do not delete the parent specification or present these runs as validated aerodynamic predictions.

## Implemented

Both WebGPU and new OpenFOAM runs record whole-car vector moments, pressure/friction moments and component forces. Confirmed axles define a road-plane reference beneath the front axle. Equivalent front/rear lift comes from total Fz and My, including drag acting above the road. Setup, saved runs, results, histories, comparison, JSON and CSV preserve that convention. Old runs without moments remain unavailable rather than receiving an invented balance.

Surface friction uses the actual fluid-on-car wall traction, in Pa or Cf. The old surface-flow data remain velocity. Stress values and validity are stored separately from colour ranges; missing samples are grey and valid zero is zero. Patch/part identity and opposing normals prevent sampling the other side of a thin wing. Fields describe the final solver state; force averages use the saved window. Compare shares the colour range and unit. PNG exports include friction units and a scale.

Quick Basic/Regular profiles keep the established solver numerics, with preflight cell/memory/device-buffer limits and paced submissions. Advanced profiles expose a two-CPU mode, selected-group and underfloor refinement, bounded native workers, periodic checkpoints, one job deadline, and sequential mesh studies. Limits are enforced; they are not assurances of convergence. Unsupported/missing diagnostics stay unavailable.

## Total tyre loads

Optional car mass (including driver/fuel) and static front weight percentage now produce steady vertical support loads for each tyre pair in both engines. Front static load is `mass × 9.80665 × front_percentage / 100`; rear carries the remainder. Each pair's total is static load minus its signed aerodynamic lift. Results show kgf, N, static weight and aerodynamic change separately. This assumes level-road, constant-speed equilibrium; braking, cornering, suspension motion and left/right distribution are excluded. A negative equilibrium demand is shown as **Unloaded**, with a loss-of-contact message, rather than a negative physical tyre support load.

Weight inputs start blank. Designs and new native/WebGPU run snapshots preserve entered inputs; the native backend returns `tyre_loads`. Existing results with saved aerodynamic moments/confirmed axles can receive an editable, separately versioned assessment, saved in this browser without changing the original CFD settings, forces or fields. JSON preserves the original run plus the assessment; history CSV uses the active assessment's static loads and each history sample's aerodynamic axle loads. Compare shows the total pair loads and identifies differing static weight inputs. Old results without valid axle balance stay unavailable.

The added checks cover force signs, weight conservation, missing/invalid inputs, loss of contact, native settings snapshots, backend mapping, typing without collapsing the editor, save/reopen and JSON/CSV exports. Invalid entered weights also block the Run button when jumping directly to that step; missing optional inputs leave CFD available. [WebGPU example](tyre-loads-webgpu.json) and [OpenFOAM example](tyre-loads-openfoam.json) retain the original result and later assessment; matching history CSV files are alongside them. These are software checks and provisional aerodynamic examples, not physical tyre-load validation.

[Native extraction](tyre-native-extraction.json) reprocesses the archived real OpenFOAM fields with 1200 kg / 55% front inputs into a temporary output directory. Cd, Cl, drag, lift and whole-car force/moment vectors remain identical; the original record's SHA-256 remains unchanged. Computed support loads are 6331.87 N front and 5021.32 N rear. The UI export examples use a later 1300 kg / 60% assessment.

## Software and native verification

The original analysis milestone passed **92 backend tests, 39 browser unit tests and 16 end-to-end tests**; the two engine-analysis browser tests also passed after the comparison changes. [Backend](backend-checks.txt), [browser unit](web-unit-checks.txt), [full browser suite](browser-checks.txt), [comparison retest](comparison-checks.txt) and [build](frontend-build.txt) transcripts are retained. The tyre-load extension passes **94 backend tests, 42 browser unit tests and 16 end-to-end tests**; production build and Ruff pass. [Final browser sweep](tyre-browser-checks.txt), [native retest](tyre-native-browser-retest.txt) and [production build](tyre-frontend-build.txt) are retained. An [earlier sweep](tyre-browser-initial.txt) had one road/wheel live-view failure; all four combinations passed on retest and in the final sweep.

The [two engine-analysis tests](tyre-analysis-final.txt) passed again after the final Run-input guard, including the direct-step invalid-weight check. [Tyre-load verification summary](tyre-load-verification.json) records the commands and scope.

- Backend tests cover manufactured loads, stress sign/dimensions/density, component reconciliation, thin-side sampling and zero/missing distinction, profile deadlines, and leases. Browser unit tests cover static force/moment conventions, translation, raw stress persistence and resource preflight.
- Browser tests exercise real WebGPU, a real OpenFOAM sample plus wing, Pa/Cf legends, saved axle snapshots, component identity, old-run fallback, save/reopen, shared Compare scales and PNG export. Existing pressure/clouds/streamlines/smoke/sections, road/wheels and underbody camera workflows remain regression targets.
- [Couette verification](couette-verification.json) runs the actual WGSL wall-stress function against the analytical laminar traction rho * nu * slip / gap. It verifies stationary and moving-wall slip, sign, magnitude, density and zero. This is analytical implementation verification, not experimental validation.
- [Native run](openfoam-run-final.json): 19,155 wall faces, 100% stress coverage. Final-state viscous force error 0.00416 N versus a 0.07991 N tolerance; viscous moment error 0.00489 N m versus a 0.08596 N m tolerance. Time-averaged component force/moment errors are approximately 1e-9 N and 5e-9 N m.
- [Independent native integration](independent-native-integration.json) integrates pressure and physical stress on the archived [native wall polygons](native-state/), not interpolated STL triangles. It passes the specified 0.5% sum-of-contributing-magnitudes tolerances. It compares the final instantaneous force/moment, not a different averaging window. Reproduce with `uv run python scripts/verify_native_wall_integrals.py`.

## Baseline and reference qualification

[Baseline](baseline-medium-51f00b4.json) was captured from unchanged revision `51f00b4` for the eight original models and three synthetic-kit variants. [Updated results](revised-medium.json) retain raw histories and diagnostic outputs. [Input manifest](input-manifest.json) records source geometry, exact conditions and STL SHA-256 hashes; original geometry remains in the local run folders. This evidence is not a portable replacement for those source STLs.

The baseline agrees closely with this revision. Small departures on separated/wake-sensitive cases are retained, not replaced with old values. Five of eight original cases meet the raw drag target; only one meets the raw lift target. **All reference comparisons remain qualification-pending** after the [reference audit](reference-audit.json): residual convergence, force settling, prism coverage or wall-resolution evidence is inadequate. The Z4 Medium reference has settled/converged forces but only 70% prism coverage; its lift discrepancy remains a measured failure, not a qualified physical result.

| Case | Baseline Cd / Cl | Updated Cd / Cl | Raw Cd error | Raw Cl error / limit | Gates | Seconds |
|---|---:|---:|---:|---:|---|---:|
| sample | 0.5124 / 0.8453 | 0.5128 / 0.8465 | -6.2% | +0.213 / 0.127 | Cd pass, Cl FAIL; reference pending | 82 |
| sample-yaw10 | 0.5836 / 0.7848 | 0.5847 / 0.7838 | -4.1% | +0.065 / 0.144 | Cd pass, Cl pass; reference pending | 91 |
| sample-wing | 0.6434 / 0.5311 | 0.6434 / 0.5317 | -5.1% | +0.116 / 0.083 | Cd pass, Cl FAIL; reference pending | 81 |
| mx5 | 0.2854 / 0.0117 | 0.2855 / 0.0119 | -10.5% | -0.215 / 0.050 | Cd FAIL, Cl FAIL; reference pending | 63 |
| z4 | 0.4036 / -0.5587 | 0.4001 / -0.5528 | -9.2% | -0.243 / 0.062 | Cd pass, Cl FAIL; reference pending | 73 |
| z4-wing | 0.3777 / -0.4588 | 0.3741 / -0.4557 | -15.8% | -0.302 / 0.050 | Cd FAIL, Cl FAIL; reference pending | 73 |
| simple-car | 0.3640 / 0.2368 | 0.3640 / 0.2363 | -1.8% | -0.256 / 0.099 | Cd pass, Cl FAIL; reference pending | 63 |
| ahmed25 | 0.3153 / 0.3065 | 0.3152 / 0.3062 | -13.6% | +0.099 / 0.050 | Cd FAIL, Cl FAIL; reference pending | 46 |
| mx5-kit-base | 0.2646 / -0.1625 | 0.2642 / -0.1635 | -17.5% | -0.395 / 0.050 | Cd FAIL, Cl FAIL; reference pending | 64 |
| mx5-kit-wing | 0.3207 / -0.2694 | 0.3207 / -0.2693 | -13.6% | -0.279 / 0.050 | Cd FAIL, Cl FAIL; reference pending | 64 |
| mx5-kit-full | 0.3307 / -0.3122 | 0.3310 / -0.3090 | — | — | pending reference | 63 |

## Separate numerical candidates

[Equilibrium log-wall treatment](candidate-log-wall.json) was tested on the sample wing and MX-5 kit wing. It reduced sample-wing Cl from approximately 0.532 to 0.474 and kit-wing magnitude from approximately -0.269 to -0.251, while kit drag agreement worsened. [Dilated thin walls](candidate-dilated-wall.json) reduced sample-wing drag but worsened lift; kit-wing Cd became 0.395 and Cl -0.364. Neither candidate consistently resolves the gates. **No candidate was promoted and no fitted Cd/Cl multiplier was introduced.** Raw failed candidate results and transcripts remain available.

The [raised-wing held-out run](heldout-raised-wing.json), excluded from these candidate tests, produced Cd 0.3359 and Cl -0.1152 in 97 seconds, versus recorded values 0.3702/-0.1180. It passes the raw absolute Cd/Cl checks but its reference diagnostics are inadequate. It cannot establish physical accuracy or modification ranking. The separately shaped grids require a matching raised-wing baseline before interpreting an incremental wing effect.

## Three-grid sensitivity

Bare sample and sample-plus-wing were run at 45, 60 and 72 cells per length with confirmed axles, ten passes and bounded extensions. All recorded force histories settled; all native stress checks passed. The grid spacing and histories are retained in the three JSON files. These are browser force-settling checks; residual/continuity qualification and physical error bounds are not inferred from them.

| Case | Cells per length | Cells | Cd | Cl | Pitch (N m) | Front / rear lift (N) | Native stress check | Settled | Seconds |
|---|---:|---:|---:|---:|---:|---:|---|---|---:|
| sample | 45 | 675840 | 0.3242 | 0.3422 | -1013.7 | -26.7 / 382.5 | pass | True | 21 |
| sample-wing | 45 | 675840 | 0.5693 | -0.2322 | 700.7 | 23.0 / -264.4 | pass | True | 21 |
| sample | 60 | 958464 | 0.5034 | 0.1867 | -1242.2 | -274.7 / 468.8 | pass | True | 36 |
| sample-wing | 60 | 1277952 | 0.6457 | -0.0195 | -616.2 | -252.7 / 232.5 | pass | True | 48 |
| sample | 72 | 1720320 | 0.5127 | 0.8469 | -2347.3 | -5.2 / 885.8 | pass | True | 101 |
| sample-wing | 72 | 1720320 | 0.6436 | 0.5322 | -1437.1 | 11.0 / 542.3 | pass | True | 81 |

The wing case changes from downforce on the coarse grid to lift on finer grids. Pitch and equivalent axle loads change substantially. These grids are not independent of resolution; a settled history is insufficient for ranking. Force variation within a window and differences between grids remain separate quantities.

## M1 resource evidence

[Browser responsiveness](browser-responsiveness.json): 8–24 ms input-to-next-frame response during a real GPU workload; cancellation took 71 ms in preparation and 155 ms during solving. This measures the CFD browser interface, not other applications or an OS-wide guarantee. The Quick memory limit is a conservative planning bound, not a measured process-RSS guarantee.

[Native cancellation](runtime-cancel.json) terminated the meshing container in 0.85 seconds. [Shortened deadline](runtime-timeout.json) completed in 29.5 seconds with a real 22-iteration checkpoint, explicitly provisional/incomplete. No solver container remained active after either terminal status.

The fresh Fast native wing run used four ranks/CPUs and about 283 MiB sampled peak container memory; combined parent/extraction RSS peaked at about 599 MiB. These are sampled, not guaranteed exact peaks. The Advanced 1 bare and wing trials used two ranks/CPUs, a 5 GiB container ceiling and 90-second test deadlines. Both timed out during meshing, with roughly 1.1 GiB sampled container peaks and no fabricated field. [Advanced 2](runtime-advanced2.json) used a 90-second shared test deadline, retained one real provisional mesh level, and stopped the study without launching finer levels. Its container peak was about 561 MiB and parent/extraction peak about 725 MiB. **Full-duration Advanced profiles and three converged native levels remain unqualified.**

## Independent physical benchmark and remaining gates

[Published Ladson NACA 0012 data](physical-reference/CLCD_Ladson_expdata.dat) and its [provenance](physical-reference/provenance.json) are retained from the [Turbulence Modeling Resource](https://tmbwg.github.io/turbmodels/naca0012_val.html). It is tripped experimental data at Re 6 million and Mach 0.15. The app's road-bounded finite car/wing cases do not reproduce that two-dimensional free-air benchmark. A matched independent lift benchmark, predeclared uncertainty-based tolerances, and its actual solve remain pending; archived data alone do not constitute validation.

Remaining completion gates:

1. Qualified native reference solutions and accurate lift/wing increments/rankings on every required case.
2. Independent physical lift validation with matched geometry/boundaries/conditions and documented reference uncertainty.
3. Three adequately converged native meshes and full-duration Advanced profile/resource qualification, including ordinary-application usability.
4. Any further solver change must rerun held-out cases, resource checks and the full numerical suite without relaxing the recorded tolerances.

The parent specification remains because these gates do not pass. UI/unit/native-integration tests cannot substitute for them.

## Reproduction

```sh
uv run pytest -q
uv run ruff check backend scripts/qualify_aerodynamics.py scripts/validate_aerodynamic_runtime.py scripts/verify_native_wall_integrals.py
npm --prefix web test
npm --prefix web run build
# A real completed run is required for the native browser checks:
cd web
EASYCFD_AERO_BACKEND=http://127.0.0.1:8031 EASYCFD_AERO_RUN=<completed-run-id> npm run test:e2e
```

`uv run python scripts/qualify_aerodynamics.py --study grid|wall-model|thin-wall` retains separate results. `scripts/validate_aerodynamic_runtime.py` accepts a backend and isolated project for shortened resource tests; it creates real runs and restores the project's settings. Never run simultaneous heavy GPU and native studies.

## Screenshots

[Imported MX-5 friction](friction-imported-mx5.png), [WebGPU sample friction](friction-webgpu.png), [saved balance](balance-reopened.png), [OpenFOAM friction](friction-openfoam.png), [OpenFOAM PNG with units](friction-openfoam-export.png), [shared Compare scale](compare-openfoam.png).

[Weight setup on Tailscale](tyre-weight-setup.png), [WebGPU tyre loads](tyre-loads-webgpu.png), [OpenFOAM tyre loads](tyre-loads-openfoam.png).
