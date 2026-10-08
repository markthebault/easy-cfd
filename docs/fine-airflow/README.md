# Detailed airflow recording

The local OpenFOAM edition has **Record flow animation → Detailed wake**. The browser-only edition retains its existing solver and standard recording. Fine recording uses a dedicated single mesh, so it cannot be combined with the Advanced multi-mesh force study.

## Computation and extraction

- `simpleFoam` prepares the initial mean field on a mesh capped at two million cells, with six requested prism layers. Car surfaces and the inner wake use refinement level 4 on a 0.5 m base cell, approximately 3.1 cm before snapping/layers. The surrounding wake uses level 3. Mesh quality and layer-coverage guards still apply.
- A separate `pimpleFoam` continuation uses `kOmegaSSTDDES`, `DeltaOmegaTilde` and `useSigma true`, following the combination in the pinned OpenFOAM 2412 `wallMountedHump` tutorial. `DEShybrid` momentum transport loads `turbulenceModelSchemes`. Physical time is adaptive with `maxCo 2`, backward temporal differencing and two pressure correctors. An independent time-step cap limits the nominal finest wake-cell Courant number to 0.35 at freestream velocity and supplies at least two steps per saved frame. Final pressure tolerance is `1e-6`.
- Eight car-length flow passes develop the transient wake. Four additional passes supply approximately 192 native timestamps. The writer can produce 189–195 frames because adaptive steps bracket the requested output times. The extractor retains their actual timestamps.
- Four cutting planes export `U`, `p` and `k` directly from the native mesh using cell-point interpolation. Each plane has at most 150,000 display samples, typically about 2 cm apart for a four-metre car. This display sampling retains available mesh detail; it does not add smaller resolved eddies to the computation.
- Surface-export roundoff is projected onto the exact section plane before triangulation and spatial probing. The projection only changes the normal coordinate. Connectivity and flow values remain unchanged, and the valid-fluid mask retains body holes. This avoids missing triangles near a zero plane coordinate.
- Binary frames contain five float32 arrays and a valid mask. The viewer loads one section at a time through four concurrent requests, interpolates adjacent velocity vectors, and preserves computed timestamps, masks and a shared colour range. High-resolution smoke is passive dye transported through these velocities. It does not change the velocity field.
- Dense recordings persist individual quantized frames in a separate IndexedDB store. The clip metadata commits after all frames are durable; changing sections then removes the previous frame generation. This avoids one multi-hundred-megabyte database value while retaining offline playback. Existing saved recordings remain readable after the schema upgrade.

The steady forces and surface data remain the original result. DDES increases visible unsteady detail; numerical accuracy still requires geometry, mesh, time-step, statistical and reference checks. This mode is an exploratory flow visualisation, not a qualified vehicle study.

A short local integration comparison on the 1,463,348-cell MX-5 mesh used the same physical checkpoint and compared `maxCo 0.4`/pressure tolerance `1e-7` with these settings over 0.00505 seconds. The four native planes retained identical fluid masks. Wake velocity RMS differences were 0.024–0.055% of freestream; plane-wide 99th-percentile differences were 0.097–0.215 m/s at a 40 m/s inlet. The faster variant took 95 seconds against 353 seconds. This checks the local integration change; it does not establish temporal convergence or qualified aerodynamics.

## Checkpoints and continuation

Fine recordings retain the latest two full-volume checkpoints, written every two flow passes. Near the time limit, the solver is asked to write a provisional checkpoint. A stopped detailed recording with a completed steady result can be continued as a separate run:

```sh
curl -X POST http://127.0.0.1:8000/api/runs/RUN_ID/continue-recording \
  -H 'Content-Type: application/json' -d '{"max_seconds":43200}'
```

The child clones its parent's mesh, fields and native sections. It starts at the latest complete physical checkpoint shared by all processor partitions, rather than resetting the flow. Partial writes and sections newer than that checkpoint are recomputed in the child. The parent remains unchanged. Solver-image identity is checked, and parent lineage is saved alongside dictionary and recording-source hashes.

To apply current recording settings while reusing the saved steady field and mesh, add `"restart_from_steady":true` to the request. This starts a new physical clock and repeats the transient development period in the child.

## Rendering and checking a video

After a detailed run completes:

```sh
uv run python scripts/render_fine_flow.py \
  --run .easycfd/runs/RUN_ID --output /path/to/airflow.mp4 \
  --width 1920 --height 1080 --fps 30 --seconds 24

uv run python scripts/analyze_fine_flow.py \
  --run .easycfd/runs/RUN_ID --video /path/to/airflow.mp4 \
  --output /path/to/analysis.json
```

The renderer uses the recorded vectors, fluid masks and actual car triangles. Its three views show the car, the wake close-up and the centreline. Each view replays the saved physical interval with a hard cut; it never interpolates across a loop seam. The movie has a fixed air-speed scale and shows physical time and the slow-motion factor. `--still 0.5` renders a frame halfway through the saved sequence for inspection.

The analysis checks all section frames for finite values, stable masking, increasing times, bounded velocity and non-negative turbulence energy. It measures temporal variation in the wake, reads solver Courant/continuity logs and decodes every movie frame. Those checks are supplemented by visual inspection of the generated movie and browser playback.

## Reproduction checks

```sh
uv run pytest backend/tests -q
uv run ruff check backend scripts
cd web
npm test
EASYCFD_WEB_TEST_PORT=5199 npx playwright test tests/e2e/flow-smoke.spec.ts tests/e2e/openfoam.spec.ts
EASYCFD_FINE_BACKEND=http://127.0.0.1:8000 EASYCFD_FINE_RUN=RUN_ID \
  EASYCFD_WEB_TEST_PORT=5199 npx playwright test tests/e2e/fine-animation.spec.ts
EASYCFD_FLOW_VIDEO=http://127.0.0.1:8801/airflow.mp4 \
  EASYCFD_WEB_TEST_PORT=5199 npx playwright test tests/e2e/flow-video.spec.ts
```

Native playback checks use a completed DDES recording: all four sections, changing computed frames, high-resolution GPU smoke, seeking, pause, section switching, unchanged steady results, offline reopening and phone layout. Unit checks cover analytic vector interpolation in every plane orientation, export roundoff, missing fluid, immutable parent checkpoints, complete partition writes and bounded continuation requests. The existing standard-recording checks remain in place.

The movie playback check requires its MP4 to be served over HTTP. It checks 1080p decoding, playback and seeking in all three views, captures browser screenshots and records decoded and dropped frame counts.

## Verified MX-5 NC recording, 8 October 2026

Run `d6cf04cb0d504706a73c9c19a45623fe` uses the existing body and four-wheel geometry at 144 km/h and 3 degrees yaw, with moving ground and rotating-wheel boundary conditions. Its 1,463,348-cell mesh passed `checkMesh` with 76.88% prism-layer coverage. The continuation reused the 500-iteration steady result, completed 4,735 transient steps and took 3 hours 38 minutes including extraction on four CPU ranks.

The saved interval is 0.800913–1.201369 physical seconds, following eight car-length flow passes. Each of the four sections contains 192 native timestamps, spaced 2.030–2.284 ms apart. All 768 section frames passed finite-value, stable-mask, zero-invalid-value, velocity-bound and non-negative-turbulence-energy checks.

| Section | Display spacing | Wake temporal velocity RMS | Maximum speed |
| --- | --- | --- | --- |
| Body height | 2.06 cm | 5.79 m/s | 54.34 m/s |
| Upper body | 2.06 cm | 3.46 m/s | 55.77 m/s |
| Centreline | 1.66–1.67 cm | 6.82 m/s | 57.76 m/s |
| Wheel wake | 1.66–1.67 cm | 6.36 m/s | 53.26 m/s |

The solver ended normally. Maximum Courant number after the initial adaptive adjustment was 1.99995; maximum absolute global continuity error was `2.42e-12`. These checks establish recording integrity and visible unsteadiness, rather than numerical convergence of vehicle aerodynamics.

The generated MP4 is 1920 × 1080, 30 fps and 24 seconds, with three eight-second views at approximately 20 times slower than physical time. All 720 encoded frames decoded without errors. Every within-view frame showed wake-region motion; mean grayscale changes per frame were 3.02, 4.49 and 1.91 levels for the body, close-up and centreline views. Browser MP4 playback and seeking passed. Playback serving requires HTTP byte ranges for seeking through the full movie.

The real native-recording browser check passed all four section selections, GPU smoke at 1536-pixel resolution, pause, seek, playback, unchanged steady results, separate-frame caching, offline reopening and a 390-pixel phone layout. The existing WebGPU recording/reload check also passed after the storage change. Backend validation passed 112 tests; web unit validation passed 55 tests; native and public production builds passed.

The case, section data, video and machine-readable analysis are retained under `.easycfd/experiments/fine-flow/`. The final video is `output/mx5-nc-fine-airflow.mp4`, with SHA256 `53be40ecf06b410d9c0584675081767e5a7adf872fbf6e493aa5629ff15b1231`.
