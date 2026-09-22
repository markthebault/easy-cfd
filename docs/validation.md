# Verification and numerical limits

This document separates software functionality, numerical behavior, and physical validation. A successful solver exit is not evidence that a car's predicted forces are accurate.

## Verified environment

- Apple M1, 16 GB host memory, macOS ARM64.
- Existing ARM64 Linux Docker-compatible runtime, about 7.7 GB VM memory.
- Pinned OpenCFD OpenFOAM 2412 multi-architecture manifest.
- Four MPI processes for the flow solution; independent meshing and reconstruction stages.
- Local React/VTK.js UI served by FastAPI at `127.0.0.1:8000`.

## Automated checks

`uv run pytest -q`: **19 passed**. Checks cover STEP embedded units, STL units/orientation/clearance, open surfaces, model confirmation, immutable geometry/settings snapshots, duplication, invalid imports, pressure conversion, drag/downforce signs, coefficient normalization, force stability, cancellation, stage failures, runtime memory budgets, comparison mismatches, near-zero percentages, reference-case Reynolds scaling, and inconclusive refinement results.

`npm --prefix frontend run build` runs TypeScript checks and produces the browser application.

Six browser scenarios passed in real Chromium with WebGL, including an active meshing cancellation. The full four-scenario suite passed first; added coverage and revised scenarios then passed targeted runs. Run them with `npm --prefix frontend run test:e2e`. It covers model review, saved setup, duplication, adding/removing the wing, actual solver submission, displaying completed results, pressure/velocity/streamline views, comparison, camera interaction, two-level Precise diagnostics, reopening saved runs, cancellation, STL import, renaming, and ZIP export. It uses the running local server and produces real CFD jobs; it is not a mocked browser demo.

Screenshots: [geometry](interface.png), [calculated slice](results.png), [comparison](comparison.png), [Precise reference result](precise.png).

## Measured Medium sample run

Run `59fbf9e6906d4e469270bb50c2dbb70c` used the simplified sample car at 100 km/h, zero yaw, moving ground, rotating wheels, density 1.225 kg/m³, and reference area 2.2 m².

| Quantity | Measured value |
|---|---:|
| Cells | 193,849 |
| Meshing | 25.3 s |
| Solver, 1,000 iterations | 248.1 s |
| Total container stages | 280.1 s |
| Faces receiving at least some prism layers | 97.4% |
| Sampled wall points within target y+ 30–300 | 73.7% |
| Cd, last 50 iterations | 0.55154 |
| Cl, last 50 iterations | 0.62804 |

The sample is a demonstration model, not a benchmark. This run **did not pass both force-stability and residual-convergence targets**. It produces usable visualization, but its force estimates remain provisional. The application displays that status. A mesh with no boundary layers is now rejected for Medium and Precise; partial coverage and near-wall resolution remain visible in the diagnostics.

## Browser-submitted Fast comparison

Chromium submitted both runs, waited for real OpenFOAM results, opened comparison, rotated the synchronized views, and reopened the saved result after a page reload.

| Quantity | Sample baseline | Sample with wing |
|---|---:|---:|
| Run | `e3f46910389d455ebc16db85ffd0b399` | `3dce4128027a4351a9307cf79bb41404` |
| Cells | 41,417 | 141,345 |
| Solver time | 15.8 s | 52.9 s |
| Cd | 0.51695 | 0.62621 |
| Cl | 0.60663 | 0.38872 |
| Drag | 537.49 N | 651.10 N |
| Downforce | −630.74 N | −404.17 N |

Both runs met the force-stability and residual targets. Fast has no prism layers, so these are demonstration results with unresolved near-wall accuracy. Negative downforce means upward lift; the sample wing reduced that lift in this calculation while increasing drag. It does not establish that a real racing component is effective. Thin-part refinement accounts for the wing case's larger mesh.

The interface shows historical times only after runs of matching geometry and preset exist.

## Published computational reference comparison

[AhmedML](https://huggingface.co/datasets/neashton/ahmedml), by Ashton, Maddix, Gundry, and Shabestari, supplies geometry and time-averaged force coefficients from hybrid RANS/LES. Its methodology and limitations are described in the [paper](https://arxiv.org/abs/2407.20801). This is a **computational reference**, not a substitute for experimental validation.

Run 1's geometry and coefficient CSV are downloaded on demand by `scripts/benchmark.py`, with fixed SHA-256 checks. The original CC BY-SA 4.0 license is saved with the downloads. Only this geometry, its small force CSV, and its license are downloaded, not the full dataset.

The comparison preserves the geometry, clearance, stationary floor, tunnel extents, lateral slip boundaries, reference area, Reynolds number, and inlet turbulence quantities. The source setup uses U=1 and nu=3.75e-7; Easy CFD uses U=40 m/s and nu=1.5e-5, scaling k by 40² and omega by 40. Coordinate translations preserve the body's position relative to tunnel boundaries. The mesh, turbulence method, solver version, and averaging procedure differ, and are recorded as limitations.

Measured Medium reference run: `81e7591269944676b3f1f39345d98543`.

| Quantity | AhmedML reference | Easy CFD Medium |
|---|---:|---:|
| Cd | 0.238486 | 0.283808 |
| Cl | −0.094516 | −0.131104 |
| Cells | About 20 million in the source methodology | 90,687 |

The drag coefficient is **19.0% higher** than the published reference. This local run met its residual and force-stability checks, which demonstrates why those checks alone cannot establish accuracy. Its meshing took 8.6 seconds and its 1,000-iteration solver run took 104.9 seconds. Layer coverage was 99.96%; sampled y+ coverage within 30–300 was 86.2%.

The full Precise workflow completed as run `31a595d9556a4c509b55f43fc3a8e086`, solving both levels and displaying the saved sensitivity result in Chromium:

| Quantity | Precise fine stage |
|---|---:|
| Cells | 162,226 |
| Cd | 0.277948 |
| Cl | −0.136412 |
| Cd difference from published reference | +16.55% |
| Fine-stage solver time | 333.4 s |
| Combined container stages, both levels | 484.7 s |
| Layer coverage | 99.65% |
| Sampled y+ coverage within 30–300 | 77.9% |
| Fine-minus-Medium Cd | −0.005846 |
| Fine-minus-Medium Cl | −0.005378 |

Both levels met force-stability checks, but the fine stage missed its stricter residual target (pressure residual 2.12e-5 versus 1e-5). The UI labels the refinement comparison **inconclusive**. Completion verifies the two-stage workflow, saved fields, and visualization; it does not establish force accuracy.

Reproduce with the local server running:

```sh
uv run python scripts/benchmark.py --quality medium
uv run python scripts/benchmark.py --quality precise
```

The full settings, case dictionaries, logs, source metadata, output fields, and reference differences are retained in `.easycfd/runs/`. The benchmark download folder also contains `comparison.json`.

## What remains unvalidated

- No physical wind-tunnel experiment or actual car was used to validate this application.
- No grid-independence, domain-independence, or formal numerical uncertainty claim is made. Two quality levels provide a sensitivity check only.
- Fine local features, contact patches, wheel detail, mesh layer coverage, and wake unsteadiness remain important sources of error.
- A steady solver can fail to settle on separated automotive wakes. A longer run is not always the solution; transient modeling may be required and is outside this release.
- Linux and WSL use the same container boundary but have not been exercised end to end on separate machines. Colima installation on a clean Mac was documented, while this test used the existing runtime.

For a quantitative design decision, require matching conditions, settled forces, acceptable residuals and near-wall resolution, adequate layer coverage, refinement and domain checks, and agreement with a suitable experimental reference. This prototype helps inspect those questions; it does not certify the answer.
