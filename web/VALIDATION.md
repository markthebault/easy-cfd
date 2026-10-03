# Validation against the OpenFOAM app

The [October 2026 investigation](../docs/webgpu-investigation/README.md) records subsequent source review, 100- and 50-attempt campaigns, and 20 matched input pairs. None established agreement within 3% or 5%. Its configurations and native references differ from the historical preset tables below. The Simple Car benchmark input has also been corrected from 100 to 200 km/h to match its Medium reference; its older mismatched comparison should not be treated as accuracy evidence.

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

## Aero parts (synthetic kit on the MX-5)

Added on 28 September 2026 with detail cells, identical grids for variants and per-part forces (see [SPEC.md](SPEC.md#aero-parts-and-variant-comparison-28-september-2026)). The question: how well does the browser solver capture what a rear wing, a splitter or canards add to a car?

**Geometry.** The MX-5 validation body and wheels, plus synthetic parts from [`validation/aero-kit`](validation/aero-kit/make-aero-kit.mjs). They are test geometry, not a real product:

- **Low wing:** inverted NACA 6412, 0.28 m chord, 1.40 m span, 10° nose-down. Its leading edge is 16 cm above the rear deck, below the roofline, so it sits in the cabin's wake. It has 10 mm endplates and two 12 mm supports.
- **Raised wing, 10°:** the same wing 25 cm higher, above the roofline.
- **Raised wing, 4°:** inverted NACA 4412 at 4° in the raised position (about 8° from zero lift). It is in the linear range, where RANS lift is dependable.
- **Front parts:** a 12 mm splitter protruding 15 cm, and two 10 mm canards at 15°.

**References.** OpenFOAM Medium runs of the legacy app on the same STL files. Its mesher refines each part to at least two cells across its thickness and adds prism layers.
- Every case that included the splitter (splitter only, splitter with canards, full kit) failed OpenFOAM's mesh quality checks. Those cases have no reference.
- In the browser, all parts of a design shape the grid, so the cases with and without a part run on identical cells.

**Browser settings.** Medium (72 cells per car length, 10 passes), with detail cells off (the default) and at 3× (`detail_ratio: 3`). With detail cells, wing profiles thick enough for the refined grid are modelled as solids thickened to 1.6 local cells. Thinner plates are zero-thickness walls in both settings. Apple M1, WebGPU.

### Changes caused by each part (Medium)

| Case | OpenFOAM ΔCd | Browser ΔCd, detail off | Browser ΔCd, detail 3× | OpenFOAM ΔCl | Browser ΔCl, detail off | Browser ΔCl, detail 3× |
|---|---:|---:|---:|---:|---:|---:|
| Low wing (in the cabin wake) | +0.051 | +0.057 (111 %) | +0.033 (65 %) | −0.221 | −0.106 (48 %) | −0.124 (56 %) |
| Raised wing, 10° | +0.051 | +0.058 (112 %) | +0.030 (59 %) | −0.343 | −0.112 (33 %) | −0.106 (31 %) |
| Raised wing, 4° | +0.023 | +0.056 (238 %) | +0.022 (95 %) | −0.280 | −0.146 (52 %) | −0.105 (37 %) |
| Splitter only | – | +0.016 | +0.018 | – | −0.073 | −0.194 |
| Splitter and canards | – | +0.017 | +0.013 | – | −0.020 | −0.137 |
| Full kit | – | +0.067 | +0.044 | – | −0.145 | −0.213 |

Baselines (browser detail off / detail 3× / OpenFOAM):
- **Low-wing grid:** Cd 0.264 / 0.323 / 0.320 and Cl −0.163 / −0.040 / 0.231.
- **Raised-wing grids:** Cd 0.278 / 0.284 / 0.319 and Cl −0.003 / 0.078 / 0.225.

The lift offset of the bare car is the known MX-5 miss listed above.

**What the checks show.**

- **Downforce from wings** is under-predicted in both settings: a third to a half of OpenFOAM's change. The ranking of the two raised wings by downforce is wrong in both. OpenFOAM gives the 10° wing more downforce than the 4° wing (−0.343 against −0.280). The browser gives them the same (detail 3×) or the reverse order (detail off). The results warn about this on every run with thin aero parts.
- **Drag changes:**
  - Without detail cells, the drag the 10° wings add is close to OpenFOAM's (111–112 %), but the 4° wing's is 2.4× too large.
  - With detail cells, the drag changes are 59–95 % of OpenFOAM's, and the two raised wings rank the right way.
- **Splitter and canards.** The splitter carries most of the front downforce: −211 N itself at detail 3×. The canards carry about −1.3 N each, because they sit in the slow flow ahead of the bumper. The front results change a lot with resolution and have no reference; treat them as unverified.
- **Where the change appears.** OpenFOAM's lift change is larger than the wing alone could carry; the rest is the wing's effect on the rear deck. In the browser, the per-part forces show the wing itself carrying 26–81 N, with only a small change on the body.
- **Runs on one grid.** The MX-5's bare-car drag varies from 0.264 to 0.322 between grids that differ only in their detail bands. That is as large as a wing's effect, which is why variants now share their grid.
- **Detail cells are off by default.**
  - **Earlier wing cars.** On the three older wing validation cars they made things worse. The sample car with a wing lost 31 % of its drag: the bands refine the edge between roof and 25° slant, and the marginal flow there switched from separated to attached. The Z4 diverged, and the Z4 with the open wing gained 25 %.
  - **Run time.** They cost 3–6× the run time (up to 11× when a run extends to its maximum length) on an M1: 4–13 min for Medium with the kit (3.1–4.0 M cells), against about 1 min without.
  - **Regression check.** With detail cells off, the original models reproduce their earlier Medium results to four digits (MX-5, sample car with wing, Z4, Z4 with wing; the sample car and the 10° yaw case within 0.3 %). The simple car now extends itself by two passes while drifting, a feature added after the tables above; it reports Cd 0.364 (−1.8 %) instead of 0.347.

### Resolution studies

These use the zero-thickness wing model from before thickening, except where marked.

| Case | 1× | 2× | 3× | 4× (solid wing) | OpenFOAM |
|---|---:|---:|---:|---:|---:|
| Low wing ΔCd | +0.057 | +0.049 | +0.043 | +0.051 | +0.051 |
| Low wing ΔCl | −0.106 | −0.212 | −0.144 | −0.126 | −0.221 |
| Raised 10° wing ΔCd | +0.057 | +0.062 | +0.089 | +0.034 | +0.051 |
| Raised 10° wing ΔCl | −0.111 | −0.166 | −0.257 | −0.112 | −0.343 |

The lift changes do not converge with resolution. The 10° wing is about 15° from zero lift, close to stall. Its flow flips between attached and separated with small changes in the grid, in the way RANS near-stall predictions are known to behave.

**The same wing alone** (no car, reference area = planform, lift coefficient of the wing):

| Wing | Cells along the chord | Model | CL | CD |
|---|---:|---|---:|---:|
| 10° | 17 | zero-thickness wall | 0.33 | 0.18 |
| 10° | 17 | thickened solid | 0.39 | 0.10 |
| 10° | 33 | zero-thickness wall (forced) | 0.43 | 0.17 |
| 10° | 33 | solid | 0.70 | 0.125 |
| 10° | 50 (detail 3×) | solid | 0.62 | 0.12 |
| 4° | 17 | thickened solid | 0.37 | 0.066 |
| 4° | 33 | solid | 0.44 | 0.073 |

- **Zero-thickness walls stall early.** A stepped zero-thickness plate has a sharp leading edge and stalls early: at 33 cells it carries 0.43 against 0.70 for the solid profile, with more drag. This is why wing profiles are now modelled as thickened solids.
- **Too little lift even when resolved.** For the 4° wing, thin-wing theory with endplates gives a CL of about 0.66. The browser gives 0.44 at 33 cells, and the result does not change with three times more flow passes. The drag of 0.07 is two to three times what such a wing should have.
- **Likely cause.** The boundary layer on small, highly loaded surfaces is too lossy. This points at the wall treatment: wall functions on Cartesian cut cells, without prism layers. More cells alone do not fix it.
- **Tried without effect.** Capping the near-wall eddy viscosity at each part's own boundary-layer thickness made no difference (CL 0.35 against 0.37), and was not kept.

**How to use the browser version for aero parts today:**
1. Compare variants on one design, which the app now guarantees runs on identical cells.
2. Read each part's own force in "Forces by group".
3. Treat downforce differences between wing versions as indicative only.
4. Cross-check the chosen wing with the OpenFOAM version.

Improving wing lift needs a better near-wall model for small parts. That is the next step, not more cells.

## Numerical checks

- Unit tests (`npm test`) check the grid, voxel and cut-cell volumes against the mesh volume, closure of the wall surface, frontal area, STL round trips, component splitting and axis conversion. They also check that switching a part off leaves the grid identical, that per-part force ranges cover every wall cell once, that overlapping shells stay solid, that wheels are never thin walls, and that detail bands and detail boxes give the finer spacing.
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

Aero parts: generate the kit (`node validation/aero-kit/make-aero-kit.mjs`) and run it through the OpenFOAM app. The `mx5-kit-*`, `mx5-hw-*` and `mx5-mw-*` entries in `models.json` point at those runs. Then:

```sh
node validation/run-validation.mjs --quality medium --models mx5-kit-base,mx5-kit-wing,mx5-kit-splitter,mx5-kit-front,mx5-kit-full,mx5-hw-base,mx5-hw-wing,mx5-mw-base,mx5-mw-wing
node validation/run-validation.mjs --quality medium --settings '{"detail_ratio":3}' --models mx5-kit-base,mx5-kit-wing
```

Results: `validation/results/final-aero-medium-detail-off.json` and `final-aero-medium-detail-3.json`.
