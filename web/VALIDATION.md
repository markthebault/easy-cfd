# Validation against the OpenFOAM app

The browser solver was compared with the EasyCFD OpenFOAM app (OpenFOAM v2412, `simpleFoam`, k-ω SST, snappyHexMesh) on the same geometry and conditions. The target in the brief was drag within ±10 % of OpenFOAM. **That target is met for 5 of 8 models on each preset, not for all of them.** The numbers below are the measured ones, including misses.

## What was compared

- **Geometry:** the exact STL files each OpenFOAM run used, read from its run folder (`.easycfd/runs/<id>/geometry`). They are the same triangles, placement and wheel definitions.
- **Conditions:** the reference run's speed, yaw, reference area, density, moving road and wheel rotation, and the same automatic tunnel (3 L upstream, 6 L downstream, 2 L to the sides and above).
- **Reference level:** OpenFOAM **Medium** (surface cells ≈ L/67 with 6 prism layers). Three models only had a Fast reference. For those, Medium references were generated for this work from the same geometry (fingerprints match): simple car, BMW Z4 and Z4 with wing. A 10° yaw case of the sample car was added the same way.
- **Browser settings:** default solver settings at the preset shown, WebGPU on an Apple M1 (Metal), headless Chromium.

`validation/models.json` lists every reference run with its OpenFOAM coefficients.

## Results

**Summary.** Fast puts 6 of the 8 models within ±10 % of OpenFOAM's drag coefficient, Medium and Precise 5 of 8, and every model is within 16 %. Seven of the eight fall within ±10 % on at least one preset; the MX-5 misses on both, by 0.4–0.6 points. The browser solver's drag is consistently lower than OpenFOAM's: the mean difference is −8.7 % (Medium, spread 4 %) and −9.1 % (Precise, spread 2 %). Lift agrees in sign and rough size on the sample-car family and the Ahmed body. It misses by 0.2–0.3 on the MX-5, the Z4s and the simple car, where the browser predicts more underbody suction.

### fast preset · final-fast.json

| Model | OpenFOAM Cd (level) | Browser Cd | ΔCd | OpenFOAM Cl | Browser Cl | ΔCl | Cells | Time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sample car | 0.547 (medium) | 0.511 | -6.5 % | 0.633 | 0.839 | +0.206 | 1.72 M | 46 s |
| Sample car, 10° crosswind yaw | 0.610 (medium) | 0.585 | -4.0 % | 0.719 | 0.795 | +0.076 | 1.72 M | 50 s |
| Sample car + rear wing | 0.678 (medium) | 0.640 | -5.5 % | 0.416 | 0.537 | +0.121 | 1.72 M | 46 s |
| MX-5 NC (smoother exterior v3) | 0.319 (medium) | 0.288 | -9.8 % | 0.227 | -0.042 | -0.269 | 1.47 M | 35 s |
| BMW Z4 (higher-res check) | 0.441 (medium) | 0.430 | -2.5 % | -0.310 | -0.607 | -0.297 | 1.47 M | 35 s |
| BMW Z4 open rear wing | 0.444 (medium) | 0.411 | -7.5 % | -0.154 | -0.488 | -0.334 | 1.47 M | 36 s |
| Simple Car CFD (one piece) | 0.371 (medium) | 0.312 | -15.8 % ✗ | 0.493 | 0.121 | -0.372 | 1.23 M | 29 s |
| Ahmed body 25° | 0.365 (medium) | 0.322 | -11.6 % ✗ | 0.207 | 0.306 | +0.098 | 1.23 M | 26 s |

Drag within ±10 %: 6 of 8.

Fast uses the Medium grid and stops after 5 flow passes instead of 10; forces on several models are still moving (shown as provisional in the app).

### medium preset · final-medium.json

| Model | OpenFOAM Cd (level) | Browser Cd | ΔCd | OpenFOAM Cl | Browser Cl | ΔCl | Cells | Time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sample car | 0.547 (medium) | 0.513 | -6.3 % | 0.633 | 0.845 | +0.212 | 1.72 M | 87 s |
| Sample car, 10° crosswind yaw | 0.610 (medium) | 0.585 | -4.0 % | 0.719 | 0.784 | +0.066 | 1.72 M | 97 s |
| Sample car + rear wing | 0.678 (medium) | 0.643 | -5.1 % | 0.416 | 0.531 | +0.115 | 1.72 M | 85 s |
| MX-5 NC (smoother exterior v3) | 0.319 (medium) | 0.285 | -10.6 % ✗ | 0.227 | 0.012 | -0.215 | 1.47 M | 66 s |
| BMW Z4 (higher-res check) | 0.441 (medium) | 0.404 | -8.4 % | -0.310 | -0.559 | -0.249 | 1.47 M | 64 s |
| BMW Z4 open rear wing | 0.444 (medium) | 0.378 | -15.0 % ✗ | -0.154 | -0.459 | -0.305 | 1.47 M | 64 s |
| Simple Car CFD (one piece) | 0.371 (medium) | 0.347 | -6.5 % | 0.493 | 0.220 | -0.273 | 1.23 M | 54 s |
| Ahmed body 25° | 0.365 (medium) | 0.315 | -13.6 % ✗ | 0.207 | 0.307 | +0.099 | 1.23 M | 47 s |

Drag within ±10 %: 5 of 8.

### precise preset · final-precise.json

| Model | OpenFOAM Cd (level) | Browser Cd | ΔCd | OpenFOAM Cl | Browser Cl | ΔCl | Cells | Time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sample car | 0.547 (medium) | 0.485 | -11.3 % ✗ | 0.633 | 0.812 | +0.179 | 2.49 M | 275 s |
| Sample car, 10° crosswind yaw | 0.610 (medium) | 0.568 | -6.8 % | 0.719 | 0.726 | +0.007 | 2.49 M | 299 s |
| Sample car + rear wing | 0.678 (medium) | 0.597 | -11.9 % ✗ | 0.416 | 0.529 | +0.113 | 3.11 M | 311 s |
| MX-5 NC (smoother exterior v3) | 0.319 (medium) | 0.286 | -10.4 % ✗ | 0.227 | 0.010 | -0.217 | 2.18 M | 208 s |
| BMW Z4 (higher-res check) | 0.441 (medium) | 0.411 | -6.7 % | -0.310 | -0.528 | -0.218 | 2.18 M | 193 s |
| BMW Z4 open rear wing | 0.444 (medium) | 0.401 | -9.8 % | -0.154 | -0.447 | -0.293 | 2.18 M | 197 s |
| Simple Car CFD (one piece) | 0.371 (medium) | 0.343 | -7.5 % | 0.493 | 0.260 | -0.233 | 2.18 M | 193 s |
| Ahmed body 25° | 0.365 (medium) | 0.334 | -8.6 % | 0.207 | 0.286 | +0.079 | 2.72 M | 194 s |

Drag within ±10 %: 5 of 8.

Time is wall time on an Apple M1 in headless Chromium, including grid preparation. Precise solves the Medium grid and a finer one (100 cells per car length) and reports their mean. The cell column shows the finer grid.

### Sensitivity studies (Medium preset unless stated)

| Change | Effect on drag |
|---|---|
| Shift the grid by ⅔ of a cell at the same resolution (sample car, MX-5) | −6 % → −27 %, −11 % → −18 % |
| Resolution 72 → 86 → 100 cells per car length (sample car) | −6 %, −20 %, −17 % |
| 1, 2 or 6 pressure multigrid cycles per step (MX-5) | identical to 4 digits |
| Minmod instead of van Leer convection | within 2 % |
| First-order upwind convection | +7–8 % (numerical diffusion) |
| Equilibrium log-law instead of k-based wall functions | within 2 % |
| Coarser wake (fine region 0.15 L instead of 0.8 L behind the car) | within 1.5 % |
| Time-accurate stepping instead of local time stepping | 1–15 % lower, 3× slower |
| Half-size cells in the road clearance | −10 to −25 %; not used |

The grid-shift result is the key limitation: on shapes whose rear-end flow is close to separating, where the surface falls within the cells changes the answer by about as much as the target tolerance. OpenFOAM behaves similarly across its own mesh levels (Fast vs Medium on the same cars: sample −5 %, sample + wing −8 %, MX-5 −3 %, Z4 +8 %, Z4 + wing +10 %, simple car +24 %). The Precise preset averages two grid levels to reduce this noise, and reports their difference as a mesh-sensitivity band.

A uniform 9 % increase would put every model within ±7 % on Precise. It was not applied: it would be a fit to these eight cases, not a physical correction, and there are no held-out models to test it against.

## Why some models miss

- **Separation on smooth and sharp-edged rear ends.** The sample car's 25° slant, the Ahmed body and the smooth fastback of the simple car sit close to the point where the flow detaches. Small differences in near-wall resolution move that point. They change drag by 10–20 % in both solvers: OpenFOAM's own Fast and Medium results differ by −5 % to +24 % on these cars.
- **Mesh structure.** OpenFOAM resolves the boundary layer with prism layers and coarsens the wake. The browser grid is Cartesian with cut cells and wall functions and a uniformly fine near wake. The two solutions converge toward each other with resolution on some models and apart on others (see the Medium/Precise columns).
- **Thin parts.** Wings thinner than about 1.5 cells are zero-thickness walls. On the sample car the wing's own drag agreed with OpenFOAM in a separate check (80 N against 86 N), but it produced about half the downforce.
- **The reference is not ground truth.** On a related geometry (AhmedML run 1), the OpenFOAM app's own documentation records its results 16–19 % above a published computational reference. A difference from OpenFOAM is therefore not necessarily an error of the browser solver, and agreement with OpenFOAM is not proof of accuracy.
- **Unsteady lift on fine grids.** On the simple car at 120 cells per length, lift never settles: it swings between 0.15 and 0.44 with a period of about 8–10 flow passes, while drag stays within ±3 %. At 72 cells the same car converges. The finer grid resolves an unsteady wake that the coarser one damps. Runs now extend while forces drift and report a ± band; the tables above predate that change.
- **Lift** is more sensitive than drag in both solvers. OpenFOAM's MX-5 lift coefficient is −0.04 on Fast and +0.23 on Medium. Treat the browser's lift as indicative only.

## Numerical checks

- Unit tests (`npm test`) check the grid, voxel and cut-cell volumes against the mesh volume, closure of the wall surface, frontal area, STL round trips, component splitting and axis conversion.
- Pressure-solver convergence does not affect the result. Running the MX-5 with 1, 2 or 6 multigrid cycles per step gave the same Cd to four digits.
- Convection scheme: van Leer and minmod give the same drag within 2 %. First-order upwind raises drag by 7–8 % through numerical diffusion and is not used.
- Wall treatment: the k-based wall functions (as in OpenFOAM) and an equilibrium log-law wall model agree within 2 %.

## Reproduce

With the OpenFOAM app's `.easycfd/runs` folder present beside `web/`:

```sh
cd web
node validation/run-validation.mjs --quality medium
node validation/report.mjs validation/results/validation-medium-*.json
```
