# Aerodynamic analysis: implementation and evidence

1 October 2026. **Software features delivered; numerical qualification remains open.** Do not delete the parent specification or present these runs as validated aerodynamic predictions.

## Implemented

Browser and native OpenFOAM runs record whole-car vector moments, pressure/friction moments and component forces. Confirmed axles define a road-plane reference beneath the front axle. Equivalent front/rear lift comes from total Fz and My, including drag acting above the road. Setup, saved runs, results, histories, comparison, JSON and CSV preserve that convention. Old runs without moments remain unavailable rather than receiving an invented balance.

Surface friction uses the actual fluid-on-car wall traction, in Pa or Cf. The old surface-flow data remain velocity. Stress values and validity are stored separately from colour ranges; missing samples are grey and valid zero is zero. Patch/part identity and opposing normals prevent sampling the other side of a thin wing. Fields describe the final solver state; force averages use the saved window. Compare shares the colour range and unit. PNG exports include friction units and a scale.

Quick Basic/Regular profiles keep the established solver numerics, with preflight cell/memory/device-buffer limits and paced submissions. Advanced profiles expose a two-CPU mode, selected-group and underfloor refinement, bounded native workers, periodic checkpoints, one job deadline, and sequential mesh studies. Limits are enforced; they are not assurances of convergence. Unsupported/missing diagnostics stay unavailable.

## Total tyre loads

Optional car mass (including driver/fuel) and static front weight percentage now produce steady vertical support loads for each tyre pair in both engines. Front static load is `mass × 9.80665 × front_percentage / 100`; rear carries the remainder. Each pair's total is static load minus its signed aerodynamic lift. Results show kgf, N, static weight and aerodynamic change separately. This assumes level-road, constant-speed equilibrium; braking, cornering, suspension motion and left/right distribution are excluded. A negative equilibrium demand is shown as **Unloaded**, with a loss-of-contact message, rather than a negative physical tyre support load.

Weight inputs start blank. Designs and new OpenFOAM run snapshots preserve entered inputs; the native backend returns `tyre_loads`. Existing results with saved aerodynamic moments/confirmed axles can receive an editable, separately versioned assessment, saved in this browser without changing the original CFD settings, forces or fields. JSON preserves the original run plus the assessment; history CSV uses the active assessment's static loads and each history sample's aerodynamic axle loads. Compare shows the total pair loads and identifies differing static weight inputs. Old results without valid axle balance stay unavailable.

The added checks cover force signs, weight conservation, missing/invalid inputs, loss of contact, native settings snapshots, backend mapping, typing without collapsing the editor, save/reopen and JSON/CSV exports. Invalid entered weights also block the Run button when jumping directly to that step; missing optional inputs leave CFD available. [OpenFOAM example](tyre-loads-openfoam.json) retain the original result and later assessment; matching history CSV files are alongside them. These are software checks and provisional aerodynamic examples, not physical tyre-load validation.

[Native extraction](tyre-native-extraction.json) reprocesses the archived real OpenFOAM fields with 1200 kg / 55% front inputs into a temporary output directory. Cd, Cl, drag, lift and whole-car force/moment vectors remain identical; the original record's SHA-256 remains unchanged. Computed support loads are 6331.87 N front and 5021.32 N rear. The UI export examples use a later 1300 kg / 60% assessment.

## Automatic wheel-based axles

Four enabled, separately marked wheels now define the front/rear axles automatically in both engines. Detection requires two clear lateral pairs; incomplete or ambiguous wheel sets need manual positions. Manual overrides remain available. Automatically sourced positions refresh when wheels move, and become unavailable when their pairs are removed.

Saved runs that contain aerodynamic moments but no axle setup can recover the balance from their saved wheel centres without rerunning CFD. The browser saves a separate `wheel-axles-1` assessment; original run settings, moments, forces and fields remain unchanged. Moments are transferred from the original reference to the road below the detected front axle using `M_new = M_old + (O_old − O_new) × F`. Histories use their own stored pitch and force coefficients; absent moments remain unavailable.

[Actual saved car verification](detected-wheel-axles-native.json) detects a 2.330 m wheelbase and recovers −277.87 N front / +82.16 N rear aerodynamic lift. At 1100 kg and 50% front static weight, combined support loads are 5671.53 N front (578.3 kgf) and 5311.50 N rear (541.6 kgf). Reprocessing the actual native fields preserves every original whole-car vector and coefficient, and the original record hash. The [real-car browser test](detected-axles-real-browser.txt) checks the independently calculated loads, persistence, JSON/CSV export and original server record; [screenshot](detected-wheel-axles-real-car.png).

Detection/recovery checks pass **96 backend tests and 44 web unit tests**; [backend](detected-axles-backend.txt), [units](detected-axles-web-unit.txt) and [production build](detected-axles-build.txt) are retained. The [first full browser sweep](detected-axles-browser-initial.txt) passed 16 tests but found a comparison header overlapping analysis controls. The header is now scrollable and the controls remain above it; the [final full sweep](detected-axles-browser-final.txt) passes all **17 end-to-end tests**, including the actual saved-car recovery.

## Software and native verification

The original analysis milestone passed **92 backend tests, 39 browser unit tests and 16 end-to-end tests**; the two engine-analysis browser tests also passed after the comparison changes. [Backend](backend-checks.txt), [browser unit](web-unit-checks.txt), [full browser suite](browser-checks.txt), [comparison retest](comparison-checks.txt) and [build](frontend-build.txt) transcripts are retained. The tyre-load extension passes **94 backend tests, 42 browser unit tests and 16 end-to-end tests**; production build and Ruff pass. [Final browser sweep](tyre-browser-checks.txt), [native retest](tyre-native-browser-retest.txt) and [production build](tyre-frontend-build.txt) are retained. An [earlier sweep](tyre-browser-initial.txt) had one road/wheel live-view failure; all four combinations passed on retest and in the final sweep.

The [two engine-analysis tests](tyre-analysis-final.txt) passed again after the final Run-input guard, including the direct-step invalid-weight check. [Tyre-load verification summary](tyre-load-verification.json) records the commands and scope.

- Backend tests cover manufactured loads, stress sign/dimensions/density, component reconciliation, thin-side sampling and zero/missing distinction, profile deadlines, and leases. Browser unit tests cover static force/moment conventions, translation, raw stress persistence and resource preflight.
- Browser tests exercise real browser OpenFOAM, a real OpenFOAM sample plus wing, Pa/Cf legends, saved axle snapshots, component identity, old-run fallback, save/reopen, shared Compare scales and PNG export. Existing pressure/clouds/streamlines/smoke/sections, road/wheels and underbody camera workflows remain regression targets.
- [Native run](openfoam-run-final.json): 19,155 wall faces, 100% stress coverage. Final-state viscous force error 0.00416 N versus a 0.07991 N tolerance; viscous moment error 0.00489 N m versus a 0.08596 N m tolerance. Time-averaged component force/moment errors are approximately 1e-9 N and 5e-9 N m.
- [Independent native integration](independent-native-integration.json) integrates pressure and physical stress on the archived [native wall polygons](native-state/), not interpolated STL triangles. It passes the specified 0.5% sum-of-contributing-magnitudes tolerances. It compares the final instantaneous force/moment, not a different averaging window. Reproduce with `uv run python scripts/verify_native_wall_integrals.py`.

## Independent physical benchmark and remaining gates

[Published Ladson NACA 0012 data](physical-reference/CLCD_Ladson_expdata.dat) and its [provenance](physical-reference/provenance.json) are retained from the [Turbulence Modeling Resource](https://tmbwg.github.io/turbmodels/naca0012_val.html). It is tripped experimental data at Re 6 million and Mach 0.15. The app's road-bounded finite car/wing cases do not reproduce that two-dimensional free-air benchmark. A matched independent lift benchmark, predeclared uncertainty-based tolerances, and its actual solve remain pending; archived data alone do not constitute validation.

Remaining completion gates:

1. Qualified native reference solutions and accurate lift/wing increments/rankings on every required case.
2. Independent physical lift validation with matched geometry/boundaries/conditions and documented reference uncertainty.
3. Three adequately converged native meshes and full-duration Advanced profile/resource qualification, including ordinary-application usability.
4. Any further solver change must rerun held-out cases, resource checks and the full numerical suite without relaxing the recorded tolerances.

The parent specification remains because these gates do not pass. UI/unit/native-integration tests cannot substitute for them.

## Reproduction

Run the current checks from the repository root:

```sh
uv run pytest -q
npm --prefix web test
VITE_ENABLE_OPENFOAM=true npm --prefix web run test:e2e
node scripts/test-browser-openfoam.mjs
```

See [current WASM evidence](../browser-openfoam/README.md) for actual browser cases, native parity, screenshots and videos. The retired numerical shader studies and their dedicated scripts have been removed.

## Screenshots

[Native friction](friction-openfoam.png), [native PNG with units](friction-openfoam-export.png), [native comparison](compare-openfoam.png), [native tyre loads](tyre-loads-openfoam.png), and [current browser results](../browser-openfoam/sample-results.png).
