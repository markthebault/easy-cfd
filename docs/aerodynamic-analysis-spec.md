# Aerodynamic analysis and validation specification

Date: 1 October 2026. Status: software milestone implemented; numerical qualification remains open.

## Purpose

Make EasyCFD useful for assessing car aerodynamic modifications: how much drag and downforce they produce, how they change front/rear balance, and where friction acts on the car. Improve the evidence behind those predictions.

The AirShaper screenshots supplied for the feature review show surface pressure, pressure clouds, surface friction, vertical/horizontal streamlines, forces, and front/rear lift coefficients. They establish visible functionality, not numerical accuracy. This specification sets EasyCFD's own requirements; it does not promise agreement with AirShaper's unseen solver.

Noise and acoustics are excluded. Cloud sharing, accounts, ownership transfer, a general UI redesign, and unrelated geometry tools are outside this implementation.

## Current baseline

Inspect the working tree before implementing. It contains existing uncommitted visualization and driving-preview work; preserve it.

| Capability | Current state | Required work |
|---|---|---|
| Surface pressure, pressure clouds, vertical/horizontal streamlines | Implemented in the current viewer | Preserve and regression-check |
| Total drag/lift, Cd/Cl, force history | Implemented for WebGPU and OpenFOAM | Add moments, axle loads, and their histories |
| Surface flow | Near-wall tangential velocity streaks | Keep distinct from a new physical friction-stress map |
| Component/group forces | WebGPU has per-part forces; OpenFOAM has body/wheel breakdowns | Provide component/group attribution for new OpenFOAM runs |
| Front/rear aerodynamic balance | Missing | Add confirmed axle positions and equivalent axle loads |
| Numerical confidence | Existing warnings and validation, with important misses | Improve diagnostics, comparisons, and solver qualification |

Evidence to retain:

- [Browser validation](../web/VALIDATION.md): Medium drag is within 10% of the OpenFOAM reference on five of eight recorded cases. Several lift coefficients differ substantially. Wing downforce changes are only 31-56% of the OpenFOAM changes, and the raised-wing variants do not rank correctly by downforce against that reference.
- [Existing web specification](../web/SPEC.md): drag and aero-part accuracy targets remain unmet. Detail refinement is opt-in because it caused regressions and did not consistently improve accuracy.
- [OpenFOAM Ahmed assessment](ahmed-validation/README.md): force extraction was verified on a controlled shared mesh, but normal presets did not establish a validated aerodynamic prediction. Convergence and agreement with another computation are separate questions.

## Required deliverables

1. Front/rear equivalent aerodynamic loads, including pitching moment, in setup, results, comparison, persistence, and exports.
2. A surface-friction map based on physical wall stress, with units, valid-data handling, and a separate surface-flow view.
3. Consistent per-part/group pressure and friction forces for both engines on new runs.
4. Clear numerical diagnostics and comparison limitations, supported by reproducible validation.
5. Measured solver improvements for lift and aero parts, assessed against the targets below.
6. Fast default presets and optional advanced runs with M1 resource limits, following the [Mac Mini simulation presets specification](m1-simulation-presets-spec.md). The user accepts up to three hours for Advanced level 1 and twelve hours for Advanced level 2, while retaining a usable computer.

Deliver software features and numerical qualification as separate milestones. Failed accuracy targets must remain visible and keep the numerical qualification milestone open.

## 1. Front/rear aerodynamic balance

### Axle setup

- Use the app's car frame: nose toward negative X, air generally toward positive X, positive Z upward, road at Z = 0.
- Add front and rear axle positions in Conditions, with visible markers and wheelbase in metres. Store the axle definition with the design and a snapshot with each run.
- Suggest positions from marked wheel centres only when two longitudinal wheel groups can be identified unambiguously. Require confirmation and allow manual entry for combined-wheel or one-piece models. Do not silently use the car's bounding-box ends.
- Require finite coordinates, front X < rear X, a positive wheelbase, and positions consistent with the car's extent. Show an actionable validation message for ambiguous or invalid input. A run may proceed without confirmed axles; its balance section must explain what is missing.
- Transform axle definitions consistently when geometry is moved, scaled, or reoriented. Invalidate confirmation when a geometry change makes the definition uncertain. Adding or disabling a wing must not move the axles.

### Definition and signs

Equivalent axle loads must come from the whole-car force and pitching moment, including pressure and friction. Splitting the surface into front and rear halves, or relabelling component forces, is insufficient.

Use a reference point on the road plane beneath the front axle, at the car's lateral centreline. Save that point explicitly. Let:

```text
O = [frontAxleX, centrelineY, 0]     reference point, m
L = rearAxleX - frontAxleX          wheelbase, m
F = sum of aerodynamic forces on all enabled car parts, N
M = sum of (wallPosition - O) cross wallForce, N m

FzRear  = -My / L
FzFront = Fz - FzRear

frontDownforce = -FzFront
rearDownforce  = -FzRear
q = 0.5 * density * freestreamSpeed^2
ClFront = FzFront / (q * referenceArea)
ClRear  = FzRear  / (q * referenceArea)
```

Positive Fz is lift. Positive My is nose-up in this frame. Positive downforce pushes the car downward. The road-plane convention includes the pitching effect of drag acting above the road; this must be stated in help and exports. These are equivalent aerodynamic axle loads, not measured tyre loads or a model of mass, suspension, braking, or acceleration.

- Include only car parts, not the wind-tunnel road or boundaries. Compute moments from force application positions on the solver walls. A resultant force drawn at an illustrative arrow position cannot supply a moment.
- Average forces and moments over exactly the same samples and weights. Derive axle loads from those averages. For WebGPU Precise, apply the same aggregation policy to forces and moments and retain each grid level's results.
- Handle the translation between browser and OpenFOAM frames explicitly. Transform moment origins as well as geometry. OpenFOAM's coefficient reference length must not be mistaken for wheelbase.
- Preserve full vector forces and moments. Normalize optional moment coefficients with a saved, explicit reference length.

### Results and comparison

- Show front and rear lift/downforce in N and kgf, ClFront and ClRear, wheelbase, and signed pitching moment in N m. Define kgf as force divided by 9.80665; avoid implying a change in vehicle mass.
- Show front downforce percentage only when both axle loads push downward and the total exceeds the documented near-zero tolerance. For mixed lift/downforce or a near-zero total, show signed loads and explain why a percentage is unavailable.
- Add front/rear load and pitching-moment histories and observed averaging-window spread. Front/rear coefficient sums must equal total Cl.
- Compare axle loads and balance changes alongside total drag/downforce. Warn when axle definitions, origins, conditions, solver versions, or engines differ. Do not automatically call a shift in balance an improvement.
- Support the same quantities in both engines. Old runs without usable moments must display the balance as unavailable; do not fabricate it from total lift.

### Acceptance

- Manufactured load tests cover a load at each axle, a load midway between axles, a pure pitching couple, drag applied above the road, mixed front lift/rear downforce, and near-zero total lift.
- Translating the complete car and axle reference together leaves equivalent axle loads unchanged. Translating an OpenFOAM case between frames yields the same loads as direct integration in the browser frame.
- FzFront + FzRear = Fz and ClFront + ClRear = Cl, within floating-point tolerance. Pressure/friction moment contributions reconcile with the total.
- Results, histories, Compare, exports, and reopened runs use the run's saved axle definition, even after the design setup changes.

## 2. Physical surface-friction map

### Solver data

- Add an explicit wall-shear-stress vector representing the tangential force exerted by the fluid on the car, in Pa or N/m². Keep the existing near-wall velocity data separate. The current `SurfaceSample.shear` is velocity in m/s and must never be presented as stress.
- WebGPU must extract the stress used by its viscous-force calculation, including its wall model, local geometry, and slip relative to moving/rotating surfaces. Do not colour near-wall speed and label it friction.
- OpenFOAM must record or derive wall stress from the solved fields using the installed solver's supported calculation. Verify field dimensions and sign. Convert kinematic stress to Pa by multiplying by density exactly once; already dimensional stress needs no density conversion.
- Preserve physical values separately from colour ranges. For thin parts, keep samples on the correct side of the wall. Do not average opposite sides across a thin wing or interpolate between unrelated nearby parts.
- Store validity explicitly. Missing, unsupported, and invalid samples must remain distinguishable from zero stress.
- Surface fields may remain final-state snapshots. Record their iteration/grid level and label them separately from time-averaged forces. Do not claim that integrating a final snapshot reproduces an average over a different window.

### Viewer

- Add Surface friction to the existing analysis picker. Colour by wall-stress magnitude, with a legend in Pa and optional skin-friction coefficient `Cf = magnitude(tauWall) / q`.
- Keep Surface flow as a separate direction view. An optional direction overlay on the friction map must use stress direction and retain a clear legend.
- Support both engines, enabled-part/group visibility, a useful default range, and an adjustable range. Compare must use one shared range and unit for both views.
- Keep physical zero at zero. Missing samples must not appear as low-friction regions. For old or unsupported runs, disable the view with a specific explanation.
- Preserve the pressure view, pressure clouds, streamlines, smoke, sections, wake views, and their existing controls.

### Acceptance

- Manufactured stress tests verify magnitude, direction, units, density conversion, a stationary wall, moving-wall slip, and zero stress.
- At the same saved solver state, native wall-stress integration matches the solver's instantaneous viscous forces. Use solver wall areas for this check, not interpolated display triangles.
- Force reconciliation tolerance is 0.5% of the sum of contributing force magnitudes, with a 1e-4 N absolute floor. Report error and coverage; do not hide missing wall faces to pass the check.
- Browser checks cover each engine, thin parts, missing data, legends, shared Compare scales, save/reopen, and PNG export with units visible.

## 3. Component forces for both engines

- Extend new OpenFOAM runs to record pressure/friction force vectors per enabled part over the same window as the whole-car forces. Preserve the association between backend patch IDs and browser part/group IDs.
- Keep group membership and names in the run snapshot. Aggregate part forces for results and Compare as the browser solver already does.
- Show drag, side force, and signed lift/downforce per group, with pressure/friction contributions available. Disabling a group must remove its forces from totals and attribution.
- Part sums must reconcile with whole-car forces using the tolerance in section 2. Apply an analogous 0.5% tolerance with a 1e-4 N m floor to moment contributions where recorded.
- If attribution is incomplete or inconsistent, show that limitation and suppress misleading group percentages or improvement claims. Existing OpenFOAM runs may retain their body/wheel breakdown without pretending to have arbitrary group forces.

## 4. Numerical confidence and design comparison

### Diagnostics

- Keep force settling, solver residual/continuity checks, mesh adequacy, and reference validation separate. Stable force history means stable over the sampled window; it does not establish physical accuracy.
- Report the checks the engine actually supports. Unsupported diagnostics must appear as unavailable rather than passed. OpenFOAM mesh failures remain hard failures; preserve residual, prism-layer, y+, and blockage warnings.
- Add stability checks for pitching moment and axle loads. Stable total lift can conceal front/rear loads that continue to change.
- Show averaging-window spread and grid sensitivity separately. The current ± band describes observed variation; it is not a statistical confidence interval or a bound on prediction error.
- Preserve the provisional state when forces or axle balance keep drifting. Retain explicit warnings for thin aero parts until the relevant qualification tests pass for the revised solver.
- Store solver/version identity, geometry identity, grid/mesh identity, actual refinement, conditions, averaging window, and moment reference with each run. Changed solver numerics or output dictionaries must update the applicable pipeline/cache identity.

### Comparison behaviour

- Continue comparing browser variants on identical grids. Preserve and display the existing shared-grid check. OpenFOAM variants may have different meshes; say so and expose available refinement evidence.
- Flag changes smaller than the observed force/load variation or measured grid sensitivity. When uncertainty information is missing, say that significance is unknown. Avoid green/red winner colouring for unresolved differences.
- Compare total forces and component effects. A wing may change forces on the rear deck as well as carry its own load.
- Keep cross-engine and changed-condition comparisons available, with their differences visible. Do not present them as isolated effects of a geometry change.

## 5. Solver qualification and improvement

Investigate the numerical causes of lift and aero-part discrepancies before choosing a fix. Near-wall treatment, thin-wall/solid representation, separation, and body/wing interaction are candidate causes. More cells alone have not solved the recorded problem.

### Validation procedure

1. Capture the current revision's baseline with the eight existing models and synthetic aero kit. Preserve inputs and raw results; report any departure from the checked-in records.
2. Qualify reference runs. Check forces, residuals, wall resolution, boundaries, and refinement. An unconverged OpenFOAM run is not a trustworthy target. Recompute inadequate references or mark their comparisons pending, with the reason.
3. Add an independent, published physical lift benchmark, a wall-friction benchmark with a defined reference solution, and one held-out car/wing case that is not used for tuning. Retain geometry provenance and reference conditions. Set benchmark-specific tolerances from the reference uncertainty and applicable modelling assumptions before assessing results. A computational or analytical reference can support verification but must not be labelled experimental validation.
4. Test candidate changes separately and retain unsuccessful results. Do not use a global Cd/Cl multiplier fitted to the existing cases as an accuracy fix.
5. Study at least three mesh/grid resolutions for representative bare-car and wing cases, with adequate convergence at each level. Report force, moment, axle-load and wall-resolution sensitivity. Averaging two levels is not proof of mesh independence.
6. Re-run the existing suite and held-out cases after choosing the change. Record speed, memory/cell budgets, and device/solver versions. Do not silently lower requested quality to meet a runtime target.

### Qualification targets

These are engineering acceptance targets, not assertions about AirShaper's accuracy. Apply them against qualified references, and report every case, including failures and pending references.

| Quantity | Target |
|---|---|
| Whole-car drag at WebGPU Medium | Within 10% of reference Cd on all eight existing cases and the held-out case |
| Whole-car lift at WebGPU Medium | Absolute Cl error <= max of 0.05 and 20% of reference magnitude; correct sign when reference magnitude exceeds 0.05 |
| Added wing drag and lift | Correct sign and error <= max of 0.03 coefficient points and 30% of the reference change |
| Ranking wing variants | Agree with qualified reference ranking where the reference difference exceeds its measured numerical variation; otherwise report the ranking as unresolved |
| Front/rear loads and moments | Agree with independent integration of the same solver output; report reference and refinement discrepancies separately |
| Friction field | Pass stress-unit, sign, native-wall integration, and validity checks; record agreement with the selected independent benchmark |
| Existing functionality | No loss of offline WebGPU operation, run reopening, group toggles, comparison, existing field views, or legacy OpenFOAM workflows |

Agreement with EasyCFD's OpenFOAM engine alone qualifies a cross-solver comparison. Claims of physical accuracy require the independent benchmark evidence and remain limited to the tested conditions.

If a target remains unmet, keep the relevant output labelled exploratory and document the remaining discrepancy. Do not weaken tolerances after seeing results, omit failed cases, or mark solver qualification complete on the strength of UI/unit tests.

## Data, compatibility, and implementation locations

Use additive, versioned data changes. Save axle definitions, moment origins, force/moment histories, physical stress samples, validity, and diagnostic provenance. Export new result quantities in JSON and applicable histories in CSV; identify OpenFOAM iteration indices separately from WebGPU pseudo-time.

Existing IndexedDB designs, stored surface samples, server runs, and exports must remain readable. Missing fields stay unavailable. Any optional reprocessing of old solver output must create a versioned derived result with provenance and must not overwrite the original record. A binary surface-sampling API change needs an explicit version or format marker and matching reader.

| Area | Existing files to inspect |
|---|---|
| Setup and result contracts | `web/src/solver/types.ts`, `web/src/store/types.ts`, `web/src/ui/ConditionsStep.tsx`, `backend/easycfd/models.py` |
| Browser forces, moments, stress | `web/src/solver/kernels/pressure.ts`, `web/src/solver/kernels/common.ts`, `web/src/solver/gpu.ts`, `web/src/solver/run.ts`, `web/src/solver/extract.ts` |
| OpenFOAM outputs and sampling | `backend/easycfd/foam.py`, `backend/easycfd/results.py`, `backend/easycfd/runner.py`, `backend/easycfd/webview.py`, `web/src/engine/openfoam.ts` |
| Results and visualization | `web/src/ui/ResultsPanel.tsx`, `web/src/ui/CompareView.tsx`, `web/src/ui/ForceChart.tsx`, `web/src/ui/AnalysisPicker.tsx`, `web/src/ui/VizDock.tsx`, `web/src/ui/Legend.tsx`, `web/src/viz/analysis.ts`, `web/src/viz/stage.ts` |
| Persistence and export | `web/src/store/codec.ts`, `web/src/store/db.ts`, `web/src/store/runs.ts`, `web/src/store/openfoamRuns.ts` |
| Validation | `web/validation/`, `web/tests/`, `backend/tests/`, `scripts/validate_ahmed.py` |

## Delivery and completion

Implement in reviewable stages:

1. Define signs, units, origins, versioned data, and independent integration tests. Establish the numerical baseline.
2. Add moments and front/rear loads for both engines, then setup, results, comparison, persistence, and exports.
3. Add physical wall stress and friction visualization, plus OpenFOAM component attribution and reconciliation.
4. Add comparison/diagnostic behaviour and complete measured solver improvements and qualification.

For each stage, supply focused tests and actual results. Run appropriate backend and web checks. Browser checks must exercise both engines, a wing variant, an old run missing new data, and save/reopen. Numerical qualification requires real solver runs and raw-field/force checks.

The final implementation report must distinguish delivered features, software checks, cross-solver agreement, independent physical evidence, unresolved targets, and runtime costs. Update [browser validation](../web/VALIDATION.md) and add the new benchmark evidence under `docs/`. Feature milestones may be delivered with explicit accuracy limitations. The complete specification is satisfied only when the required deliverables and measured acceptance targets pass; unresolved numerical targets remain an open milestone.
