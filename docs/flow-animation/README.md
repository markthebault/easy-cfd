# Flow animation validation

Validated on 6 October 2026 using both actual solver paths.

- Backend: 98 pytest tests passed, including continuation-clock and animation API bounds checks.
- Web units: 47 tests passed, including timestamp interpolation, storage round trips and capture cancellation.
- Browser suite: 15 tests passed; four existing optional fixture/edition tests were skipped. The animation test runs the real WebGPU solver, verifies 24 increasing timestamps and changing fluid samples, exercises pause, seek, non-looping playback and steady-slice switching, reloads the saved frames, and checks the mobile layout.
- Public edition: the separate WebGPU-only browser test passed and made zero backend API requests. Both production edition builds passed. Native playback also fits 320 px and 390 px viewports without horizontal overflow.
- Native OpenFOAM: a complete Fast sample-car run with moving road and rotating wheels continued with `pimpleFoam`. The local API returned 24 frames over 0.454 physical seconds, with 119,952 samples per frame. 116,830 sampled velocities changed by more than the validation threshold between the first and final frames. The saved run was imported and played through the browser UI.

The native measurements are in [openfoam-validation.json](openfoam-validation.json). This is software and data-path validation on a coarse sample mesh; it does not establish aerodynamic accuracy or statistically converged wake behaviour.

```sh
uv run pytest -q
uv run ruff check backend scripts
npm --prefix web test
EASYCFD_WEB_TEST_PORT=5198 npm --prefix web run test:e2e
VITE_ENABLE_OPENFOAM=false EASYCFD_WEB_TEST_PORT=5198 npm --prefix web run test:e2e -- tests/e2e/edition.spec.ts
npm --prefix web run build
VITE_ENABLE_OPENFOAM=true npm --prefix web run build
```

To reproduce the native path, start the local OpenFOAM server with an isolated `EASYCFD_DATA` directory, select the sample car and OpenFOAM Fast, enable **Record flow animation**, and run. Select **Explore airflow → Flow animation** after completion. Native validation requires Docker/OpenFOAM; the default browser suite uses a mock server for its existing OpenFOAM UI checks.
