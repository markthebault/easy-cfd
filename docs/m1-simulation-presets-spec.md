# Simulation presets for the Mac Mini M1

Date: 1 October 2026. Status: controls and guards implemented; full profile qualification remains open.

This extends the [aerodynamic analysis specification](aerodynamic-analysis-spec.md). Keep the default simulation fast and add optional advanced runs that preserve the usability of the user's Mac.

The user accepts a maximum of **3 hours for Advanced level 1** and **12 hours for Advanced level 2**. These are elapsed-time limits for the complete job, not minimum runtimes or promises that every geometry will converge.

## What the AirShaper screenshot establishes

| Tier in the supplied screenshot | Advertised cells | Advertised time | Stated purpose |
|---|---:|---|---|
| Basic | 1 million | 30 minutes to 4 hours | Initial concepts and basic shapes |
| Regular | 10 million | 3 to 10 hours | Detailed designs; component forces |
| Advanced | 100 million | 1 to 3 days | Final design changes; component forces; rotating elements |

Cells are the small volumes into which the fluid domain is divided for calculation. More cells can resolve smaller features, but the count alone does not establish accuracy. Allocation around the car, wall treatment, geometry, boundary conditions, and convergence also matter.

A likely distinction between those tiers is increasingly fine resolution around surfaces and in the wake, with more computational work. This is an inference. The screenshot does not reveal the solver, turbulence model, wall-layer settings, local cell sizes, iteration budgets, memory, or computing hardware. Do not claim to reproduce AirShaper's configuration.

For illustration only, a uniform 10-fold increase in three-dimensional cell count reduces the linear cell size by about 2.15 times. Actual locally refined meshes do not obey that simple relationship everywhere. AirShaper's advertised times cannot be transferred to this Mac or to EasyCFD.

## Verified local starting point

- The available machine is an Apple M1 Mac Mini with **16 GB unified memory** and eight CPU cores, four performance and four efficiency cores.
- The existing OpenFOAM runtime reports about **7.7 GB VM memory**. Current presets cap a solver container at 3, 5, or 6 GiB and use four MPI processes by default.
- The [recorded CPU comparison](validation.md#solver-process-count) found four processes faster than six or eight on the tested small meshes. Two-process performance for the proposed advanced workloads has not been measured.
- Browser Medium currently uses 72 cells per car length and ten flow passes, with detail refinement off. Fast uses the same spatial resolution and five passes. Typical validation grids have 1.2-1.7 million cells; recorded Medium runs took roughly one to two minutes. See [browser validation](../web/VALIDATION.md).
- Saved OpenFOAM runs inspected on 1 October include wing cases with about 0.58-0.60 million cells and 24-25 minutes of solving, about 32-34 minutes across recorded container stages. Those runs still had unsettled forces. The [Ahmed Precise record](ahmed-validation/README.md#follow-up-normal-precise-preset) used about 0.31 million cells and 10.5 minutes of solving on its fine level.
- The current WebGPU Custom control permits up to 220 cells per length. Its 4.5-million-cell detail budget limits optional refinement, not every possible base grid. OpenFOAM's existing stage timeout is 24 hours. Neither is the resource policy required here.

Do not reproduce the earlier machine-blocking run to diagnose it. Its cause has not been established. Implement preflight limits, bounded work, monitoring, and cancellation, then qualify the new profiles gradually.

## User interface

Add two tabs inside the existing Run step:

1. **Quick simulation** is the default. It contains Basic and Regular; Regular is recommended for everyday work.
2. **Advanced simulation** contains Advanced level 1 and Advanced level 2. Both use the local OpenFOAM engine and explain that it must be available. They are optional checks for selected designs, not the default way to iterate.

Each profile shows its purpose, engine, estimated or measured cell count, runtime estimate and maximum duration, memory budget, and resource mode. Use "up to 3 hours" and "up to 12 hours" for the advanced deadlines. Show "not yet benchmarked" until there are relevant measurements; do not invent a precise ETA.

Remove "Final numbers" and equivalent accuracy promises from preset descriptions. Use effort and purpose labels. Keep old Fast/Medium/Precise/Custom runs readable with their original settings. Do not silently reinterpret old saved results as one of the new profiles.

All analysis outputs, including component forces, friction maps, and axle loads when their data are available, remain accessible at every tier. Tier choice controls computational effort, not an artificial feature paywall.

## Recommended initial profiles

These are starting settings for implementation and qualification, not configurations already proven safe or accurate. The actual mesh depends on geometry. Cell ceilings are enforced limits, not requested target counts.

| Setting | Basic | Regular | Advanced level 1 | Advanced level 2 |
|---|---|---|---|---|
| Engine | WebGPU | WebGPU | OpenFOAM | OpenFOAM |
| Purpose | Check setup and broad flow | Fast design comparisons | More detailed wall/wake solution and convergence check | Mesh-sensitivity study for a final candidate |
| Spatial resolution | 72 cells/car length | 72 cells/car length | Targeted body, wheel, underfloor and aero-part mesh | Three sequential mesh levels with finer local resolution |
| Typical/intended cells | Existing 1.2-1.7 M examples | Existing 1.2-1.7 M examples | Initial planning range 0.5-1.0 M | Initial planning range 1.0-2.0 M on the finest level |
| Hard cell ceiling | 2.5 M | 2.5 M | 1.0 M | 2.0 M per mesh level |
| Solve budget | 5 flow passes | 10 passes, bounded extension | Up to 6,000 iterations | Up to 10,000 iterations per level, subject to the shared deadline |
| Wall treatment | Existing SST wall model | Existing SST wall model | SST with wall functions and initially 8 prism layers | SST with wall functions and initially 8-10 prism layers |
| Extra detail refinement | Off | Off | Local mesh refinement at important parts | Stronger local refinement, not global refinement everywhere |
| Resource mode | Paced GPU submission | Paced GPU submission | 2 MPI ranks; 2-CPU quota | 2 MPI ranks; 2-CPU quota |
| Container memory ceiling | Not applicable | Not applicable | 5 GiB, no extra swap allowance | 6 GiB, no extra swap allowance |
| Elapsed-time ceiling | 5 minutes | 10 minutes | 3 hours total | 12 hours total across all levels |

The Quick deadlines bound automatic extension and exceptional geometries. They do not replace the current short-runtime goal. Preserve the validated default numerics unless a measured change justifies replacing them.

OpenFOAM and WebGPU cell counts are not interchangeable. The browser uses a stretched Cartesian grid; OpenFOAM can concentrate cells in surface layers and selected regions. An OpenFOAM result with fewer cells overall is not automatically less resolved where it matters.

### Advanced level 1

- Start from the current OpenFOAM Precise mesh recipe, without automatically repeating Medium. For a car approximately 4.2 m long, the current nominal background spacing is about 0.4 m and surface level 3 gives about 0.05 m before geometry-specific refinement. Preserve length scaling for other models.
- Add local refinement to approximately 0.02-0.03 m around the selected aero parts, wheel wakes, and relevant underfloor gaps when the cell and memory budgets permit it. Thin geometry may need more than these illustrative sizes; inspect the mesh rather than assuming it is resolved.
- Aim for about 0.5-1.0 million cells through useful allocation, with a hard ceiling of 1.0 million. Do not fill the budget merely to advertise a larger number.
- Initially use eight prism layers, the existing SST model, the moving-road setting and configured wheel rotation. Preserve the user's conditions, tunnel extent, reference area, and geometry.
- Target residuals at or below 1e-5 for the currently monitored fields and stable drag, lift, pitching moment, and axle-load averages. Stop early when the documented checks pass; do not always consume 6,000 iterations or three hours.
- Label this as a detailed numerical check. A single mesh does not establish mesh independence or experimental accuracy.

### Advanced level 2

- Run three sequential OpenFOAM meshes on the same geometry, conditions, model, and moment reference. Plan approximately 0.5, 1.0, and 2.0 million cells, adjusting the refinement recipe to geometry; save actual counts and local spacings.
- Refine surface, underfloor, important aero parts, and wake together in a controlled way. Use comparable growth ratios and wall-treatment assumptions; unrelated recipe changes must not masquerade as a resolution study.
- Start with 8-10 prism layers. Choose first-layer thickness for the existing wall-function approach, initially aiming for y+ 30-300. Check actual y+ and layer coverage on critical parts. Layer count by itself is not proof of adequate wall resolution.
- Require convergence/stability evidence on each level before interpreting the differences. If a level remains unstable or fails mesh quality, retain its evidence and report the refinement study as inconclusive. Do not automatically proceed to more expensive levels when an unresolved failure makes them uninformative.
- Share one twelve-hour deadline across preparation, meshing, all solves, reconstruction, and result extraction. Reserve time for writes and cleanup; do not give each level its own twelve-hour allowance.
- Report each level's Cd, Cl, moments, axle loads, component forces, convergence, wall coverage, timings, and changes between levels. Do not average inconsistent levels into a supposedly accurate final number.

### Controls to expose

Keep recommended values selected. Offer only useful controls initially: chosen profile, lower runtime limit, resource mode, and which parts/regions need local refinement. Put detailed mesh/iteration settings in an expert disclosure, subject to the same limits.

Use **Keep Mac responsive** by default for both advanced levels. An optional **Faster solve** mode may use four ranks/four CPUs only after benchmarking it within the same memory ceilings. Do not automatically use all eight cores or change the VM's CPU/memory allocation.

Existing WebGPU detail refinement stays experimental and off by default. It must not be the mechanism behind an advertised advanced accuracy tier until its recorded regressions are resolved. Hide unrestricted Custom resolution from the default path; expert settings must still pass preflight.

## Resource and responsiveness requirements

### Before starting

- Build a conservative resource estimate before full geometry voxelization, mesh construction, or GPU allocation. Include CPU preparation arrays, solver buffers, multigrid levels, staging/readback copies, surface samples, and visualization data.
- For Quick runs, reject grids above 2.5 million cells or an estimated 3 GiB peak simulation allocation. Check each GPU buffer against the actual adapter's binding/allocation limits. This is a planning ceiling to verify on the M1, not an OS-enforced total-memory guarantee.
- For advanced runs, enforce container limits plus a conservative combined-job memory budget of 8 GiB, including native meshing/result-extraction workers and browser result transfer. Serialize expensive phases and avoid keeping multiple full fields in memory unnecessarily.
- Check current machine/runtime availability and disk headroom. Retain at least the existing 8 GB free-disk prerequisite; increase the estimate for a multi-level study based on projected artifacts. Do not delete previous results automatically to make room.
- Reject a request that exceeds a budget with an explanation and a concrete smaller profile/refinement choice. Do not silently reduce the mesh, shrink the tunnel, omit an aero part, or replace a physical model.
- Treat memory and timing estimates as uncertain until calibrated for the geometry class. Cell ceilings alone cannot guarantee peak memory.

### During a run

- Allow one heavy simulation job at a time on this machine. Prevent concurrent WebGPU solving and local OpenFOAM meshing/solving from consuming the shared host resources. Browser tabs and server jobs must coordinate or detect conflicts.
- Enforce CPU/memory limits for meshing and solving. Put expensive native result extraction and geometry preparation in bounded workers rather than an unbounded server request. Browser GPU work cannot be limited by a Docker CPU quota.
- Pace WebGPU command submission in small batches with yields. Reduce live-field/readback/render frequency when needed to keep controls responsive; this must not silently change solver numerics or averaging.
- Measure peak memory where supported, available memory pressure, queue durations, and stage timings. If resource pressure becomes unacceptable, stop safely and explain the cause instead of waiting for the machine to become unusable. Where a browser cannot observe system pressure, use conservative preflight budgets and bounded allocations.
- Keep progress and **Stop** available through meshing, solving, reconstruction, and extraction. Target stopping within five seconds, including the active worker/container, with bounded cleanup. Retain completed checkpoints and logs.
- Track one monotonic deadline per job, persisted in the server run record. Automatic iteration extensions and additional mesh levels cannot bypass it. A queued job's computation deadline starts when it begins preparation, not while waiting in the queue.
- Save full-field checkpoints periodically for long OpenFOAM solves, initially every 250 iterations, retaining a bounded number per level. Preserve unique processor data until reconstruction proves coverage. Do not reconstruct and transfer a full field on every live UI update.
- On timeout or resource stop, use a completed checkpoint if one exists and label it provisional/incomplete. If no valid field exists, show logs and status without fabricating airflow. Graceful writing and cleanup must fit within the planned deadline reserve.
- Closing the UI must not stop an advanced server run. Its resource limits and deadline remain enforced server-side; reopening must show the actual job state. Do not promise restart/resume after a solver or backend crash unless separately implemented and tested.

## Qualification and acceptance

Implement the controls and guards before enabling large profiles. No 10-million- or 100-million-cell local preset is included for this M1. Reconsider those only with separate hardware and measured evidence.

1. Unit/backend checks cover profile mapping, unsupported advanced-engine availability, memory and cell preflight, GPU-buffer limits, a shared deadline across levels, automatic-extension limits, and cancellation. Test timeouts with shortened budgets rather than waiting three or twelve hours.
2. Old runs retain their engine and exact settings. New runs save the selected profile, actual mesh, ranks/quota, memory ceilings, time limit, timings, and reason for early termination.
3. Benchmark Basic and Regular on the sample car and an imported car. Preserve the current roughly one-to-two-minute experience for ordinary cases; show actual timing changes and remaining accuracy limitations.
4. Qualify Advanced level 1 on a bare car and a wing case, escalating mesh size gradually. Verify peak memory, local mesh quality, wall coverage, convergence, axle loads, and the system's responsiveness. A failed mesh is not a successful advanced run.
5. Qualify Advanced level 2 on a representative case with three converged levels, or explicitly record why the study remains inconclusive. The twelve-hour limit is not waived to obtain a passing result.
6. In responsiveness checks, verify that other ordinary applications remain usable and the CFD interface responds to input. Target typical UI response within 200 ms and stopping within five seconds; record measured behaviour rather than claiming an absolute OS guarantee.
7. Confirm cleanup releases workers, containers, and GPU buffers. Confirm a stopped/timed-out run cannot stay active in the background after the UI reports it stopped.
8. Publish measured runtimes and memory peaks, including failures, under `docs/`. Keep "proposed/not benchmarked" labels until these checks have passed. Numerical accuracy still follows the gates in the aerodynamic analysis specification.

## Implementation locations

Extend the existing Run-step UI and engine mapping rather than creating a separate solver application. Inspect `web/src/ui/RunStep.tsx`, `web/src/solver/types.ts`, `web/src/store/estimate.ts`, `web/src/solver/grid.ts`, `web/src/solver/setup.ts`, `web/src/solver/gpu.ts`, and the existing cancellation/run orchestration.

For advanced profiles, extend `backend/easycfd/models.py`, `backend/easycfd/foam.py`, `backend/easycfd/runner.py`, the server API, and `web/src/engine/openfoam.ts`. Named advanced profiles need explicit recipe and resource metadata; the existing generic Custom iteration control alone does not provide local-refinement, responsiveness, or whole-job timeout requirements.

Preserve the original aerodynamic-analysis work, local-first Quick operation, old server runs, and unrelated working-tree edits. Deliver only the specified UI/solver/resource changes; do not change the Mac's or Docker VM's global settings automatically.
