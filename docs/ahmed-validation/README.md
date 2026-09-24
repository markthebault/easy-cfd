# Ahmed body comparison, 24 September 2026

EasyCFD's force extraction and displayed fields passed this comparison. Its normal Medium preset did **not** reproduce the reference forces reliably for this Ahmed body. The native run remained unsteady in force history and missed its residual target. Do not use it to rank designs.

| Run | Cells | Iterations | Mean Cd | Mean Cl | Solver time |
|---|---:|---:|---:|---:|---:|
| Published Nathan Rooy case 1-A | 8,250,693 | Not independently reproduced | 0.299 | 0.339 | Not measured |
| Locally run reduced reference | 184,233 | 500 | 0.330371 | 0.334382 | 99 s |
| EasyCFD, controlled shared mesh | 184,233 | 500 | 0.330391 | 0.334356 | 107 s |
| EasyCFD, normal Medium | 159,190 | 1,000 | 0.364709 | 0.207306 | 200 s |

All local force values average the final 50 iterations. Full measurements, IDs, timings and field discrepancies are in [measurements.json](measurements.json). Runs remain available in the local application and can be exported there. The source and local reference case remain in `.easycfd/reference/`.

## Follow-up: normal Precise preset

Run `e9453fcf9a394fd89f167a2ccab7d13f` used the same imported geometry, driving conditions and pipeline as the earlier native Medium run. No solver defaults were changed. Precise repeated Medium and then solved its finer mesh for 1,800 iterations.

| Stage | Cells | Cd | Cl | Forces settled | Residual target reached |
|---|---:|---:|---:|---|---|
| Medium repeat | 159,190 | 0.369921 | 0.243512 | No | No |
| Precise | 310,851 | 0.358167 | 0.404479 | Yes | Yes |
| Reduced reference | 184,233 | 0.330371 | 0.334382 | Steady final force window | Different numerical setup |

The Precise stage took 10.5 minutes of solver time. Total container stages, including the Medium repeat, took about 14.9 minutes. Cd remained within 1.1e-7 and Cl within 4.6e-7 over the final 200 iterations. Its largest final monitored residual was approximately 1.1e-7, below the 1e-5 target.

Precise resolves the observed convergence problem on the finer mesh, but differs from the reduced reference by **+8.4% Cd and +21.0% Cl**. This is not a validated force prediction. The two-level refinement check remains inconclusive because Medium did not converge. Near-wall resolution also needs review: 78.2% of sampled wall points met the application's y+ target of 30–300; maximum y+ was 1,337, despite 98.2% layer coverage.

The repeated Medium result differed from the earlier Medium average by +0.00521 Cd and +0.03621 Cl. The two runs' mesh points, faces, owner/neighbour connectivity, numerical scheme files and initial U/omega files were byte-identical. The source of the different numerical trajectories was not isolated. Both histories remained unsettled, so neither final-window average should be treated as a reproducible steady solution.

**Decision:** retain current defaults pending controlled tests. More iterations alone are unlikely to change the converged Precise result. To explain the remaining reference gap, test the reference inlet omega and tunnel boundaries separately on the same fine mesh where possible, then assess boundary-layer and wake resolution. The current evidence does not identify one setting that should be changed globally. Do not tune only Cd; retain lift, field and wall-resolution checks.

The force-history chart exposed a display defect: automatic scaling amplified approximately 1e-7 coefficient noise into full-height oscillations, with identical rounded axis labels. The chart now uses a minimum vertical span of 2% of the coefficient magnitude, with a 0.01 coefficient floor, so converged noise appears flat. This changes only the visualization, not solver data or convergence criteria.

Raw-field, pressure-unit, force-sign and coefficient-averaging checks passed for Precise. Browser checks covered the actual saved result, diagnostics and four field views. [Measurements](precise-measurements.json) · [Browser checks](precise-ui.json) · [Pressure](precise-pressure.png) · [Diagnostics](precise-diagnostics.png).

To repeat on a fresh saved-run pointer:

```sh
uv run python scripts/validate_ahmed.py precise
uv run python scripts/report_ahmed_precise.py
node scripts/check_ahmed_ui.mjs precise
```

## Reference selection

Selected [nathanrooy/ahmed-bluff-body-cfd](https://github.com/nathanrooy/ahmed-bluff-body-cfd), commit `25677d638b1ae6f1289cb6b70fce666f898ce560`. Its README publishes force coefficients, mesh size and wall resolution for a 25° body using simpleFoam and kOmegaSST, matching EasyCFD's solver/model family. GitHub reported 23 stars and 8 forks when checked.

Also checked [jamesduv/ahmedBodyParametric_Public](https://github.com/jamesduv/ahmedBodyParametric_Public), with 2 stars, and [hweifluids/Ahmed-Body-Various-Platform-and-Mesh](https://github.com/hweifluids/Ahmed-Body-Various-Platform-and-Mesh), with 0 stars. The selected repository had more directly usable published results. These are specialist examples, not large projects whose popularity establishes accuracy.

The published experimental numbers are reported by the repository, not independently verified wind-tunnel data in this audit. The 8.25-million-cell case was not run. This is software and computational-reference verification, not experimental validation.

## What was run

All three local solves used the installed pinned ARM64 OpenCFD 2412 image, four MPI ranks, and no solver-container network access. The independent reference and shared-mesh runs were limited to 5 GB and 20 minutes per command. Successful local stages totaled about 7.8 minutes across the three runs, excluding compatibility troubleshooting, browser checks and analysis.

The source repository targets OpenFOAM Foundation 7. To run locally:

- Used OpenCFD 2412 for both sides, so this does not test agreement between OpenFOAM distributions.
- Reduced surface, feature and region refinement levels by two. Retained layers and bounded the cell budget at 1.4 million.
- Raised the entire source geometry 5 mm in both local cases, matching EasyCFD's minimum clearance. This also changes body clearance, not just the support tips. The published case's supports touch the floor.
- Used `surfaceFeatureExtract`, corrected the mesh-quality include path, supplied `nSmoothScale=4` and `errorReduction=0.75`, and used the OpenCFD spelling `minMedialAxisAngle`.
- Changed the hierarchical decomposition from six ranks to four, with divisions `(2 2 1)`.
- Copied `U.orig` to `U`; omitted optional upstream streamline and cutting-plane function objects. Meshed serially and solved in parallel.

The reduced reference retains 40 m/s flow, moving ground, kinematic viscosity 1.5e-5 m²/s, inlet k=0.24 and omega=1.78, slip sides/top, the source tunnel and reference area **0.115032 m²**. That is the value in the source force dictionary; it was not replaced with a more familiar Ahmed frontal area.

The normal EasyCFD run used the same geometry, 5 mm support gap, speed, moving ground, viscosity, area and density 1 kg/m³. It used the application's normal tunnel, inlet omega, meshing, initialization and numerical settings. Thus its discrepancy does not isolate a single cause. No preset was tuned to match the reference coefficient.

The controlled EasyCFD run used the reference's actual mesh, coordinates, boundary conditions, initialization with potentialFoam, numerical schemes and 500 iterations. Its initial field and force dictionaries were generated by EasyCFD and adapted explicitly by [validate_ahmed.py](../../scripts/validate_ahmed.py). Density was deliberately 1.225 kg/m³ to exercise pressure/force conversion; incompressible Cd and Cl remain comparable, but dimensional forces and pressure must account for density. This is a custom verification case, **not** a standard Medium run. A distinct pipeline identity and boundary configuration prevent the app from treating it as an ordinary same-conditions design comparison.

## Findings

The shared-mesh force differences were ΔCd=0.00001986 and ΔCl=-0.00002547, approximately 0.006% and 0.008%. Both force histories were steady over the final window. The controlled EasyCFD run still missed its stricter residual target, which the UI reports.

Final fields were close overall, not identical. Relative L2 differences were 0.066% for volume pressure, 0.210% for velocity, and 0.086% for body-surface pressure. The 99th percentile velocity difference was about 0.038 m/s. About 0.028% of cells differed by more than 1 m/s, with a maximum vector difference of about 16.5 m/s near the support legs. Small global force differences do not establish local flow accuracy or full convergence.

The normal Medium run's Cd was 10.4% above the reduced reference and 22.0% above the published result. Cl was 38.0% below the reduced reference. Its final-window Cd span was 0.0252 and Cl span was 0.0962. The UI correctly warned that forces were still changing and residuals had not converged. This run is not a reliable Ahmed force prediction. The reduced reference itself had 10.5% higher Cd than the published fine-mesh value, so neither coarse setup establishes mesh independence.

Independent checks in [report_ahmed.py](../../scripts/report_ahmed.py) read the solver coefficient tables and raw VTK/OpenFOAM cell fields. For both EasyCFD runs:

- Saved Cd and Cl equal the final-50-row means.
- Drag and signed downforce use `0.5 × density × speed² × area`, with downforce equal to negative lift.
- Saved pressure equals raw kinematic pressure times density. Saved k and velocity magnitude match the raw fields.
- The stationary body has zero surface velocity.

No force-sign, coefficient normalization or pressure-conversion error was found in these runs. These checks cannot establish the absence of all solver or application errors.

## Browser checks and display correction

Local Chromium with software WebGL checked both actual runs, including rounded force cards, lift/downforce direction, kilograms of equivalent weight, warnings, legend ranges, surface pressure, speed slices, streamlines and animated pressure planes. No page errors or failed HTTP responses occurred. [Native checks](native-ui.json) and [controlled checks](matched-ui.json) record the run IDs.

The UI previously left the averaging distinction implicit. It now labels fields with their saved iteration and explicitly states the force averaging window, with a provisional-force reminder when checks fail. Forces are averaged; the colored fields are a final-iteration snapshot. This matters for the native run's changing lift.

[Native pressure](native-pressure.png) · [Native diagnostics](native-diagnostics.png) · [Controlled pressure](matched-pressure.png) · [Controlled diagnostics](matched-diagnostics.png) · [Side-by-side UI](comparison.png)

The side-by-side screen warns that density, simulation template and boundary configuration differ. Compare coefficients here; do not interpret its dimensional force differences as a design improvement.

## Reproduce

Start EasyCFD normally. On a fresh validation directory:

```sh
git clone https://github.com/nathanrooy/ahmed-bluff-body-cfd.git .easycfd/reference/nathanrooy-ahmed
git -C .easycfd/reference/nathanrooy-ahmed checkout 25677d638b1ae6f1289cb6b70fce666f898ce560
uv run python scripts/validate_ahmed.py native
uv run python scripts/validate_ahmed.py upstream
uv run python scripts/validate_ahmed.py matched
uv run python scripts/report_ahmed.py
node scripts/check_ahmed_ui.mjs native
node scripts/check_ahmed_ui.mjs matched
```

Run these sequentially, with no other solver jobs. The upstream command refuses to overwrite its existing case. Preserve previous cases if repeating the audit. The cloned geometry is retained locally; it is not redistributed in this repository.

Validation also passed 57 backend tests, Ruff checks and the frontend production build. The build retains its existing bundle-size advisory.
