# Browser OpenFOAM

The static app runs OpenFOAM v2512 in a browser worker, in double precision and
serial mode. `blockMesh`, `snappyHexMesh` and `checkMesh` build and check the car
mesh. `browserFoam` uses the stock `simpleFoam` SIMPLE equations, k–omega SST,
and stock boundary conditions on a static mesh. It adds wall integration and
field sampling for the existing `RunResult`, `VizField` and `SurfaceSample`
contracts. It runs the upstream OpenFOAM numerical implementation.

Quick and Fast are light browser presets. Detailed uses a finer car/wake mesh,
1,000 iterations and a 600,000-cell ceiling, with a 60-minute whole-job limit.
The cell count depends on the geometry; the ceiling is not a fixed mesh size.
Advanced meshes and physical-time
recordings continue to use the existing connected OpenFOAM API. Browser runs
make no API requests, including when a remote backend is configured.

## Build

Requirements: Docker, Git, Python 3, ripgrep, Node 22 and npm. The compiler image
and OpenFOAM release are pinned in `build.sh`. Compilation needs a few GB of
RAM and considerably longer than the frontend build; users do not need Docker.

```sh
npm --prefix web ci
bash wasm/build.sh
VITE_ENABLE_OPENFOAM=false npm --prefix web run build
```

To reuse an existing OpenFOAM source/build tree:

```sh
EASYCFD_FOAM_SOURCE=/absolute/path/to/openfoam JOBS=8 bash wasm/build.sh
```

`web/public/openfoam/` contains the generated modules and manifest. Binaries
are split into 8 MiB assets so every file fits Cloudflare Pages' 25 MiB limit.
The worker normally downloads about 15 MiB of precompressed binaries, decompresses
them locally, checks their SHA-256, and instantiates WASM
locally. Ship the entire `web/dist/` directory to any static HTTPS host. No
Cloudflare Function, Worker service, API or solver container runs at runtime.
Serial mode needs no SharedArrayBuffer or COOP/COEP headers. Serve `.js` files
with a JavaScript MIME type. The app's CSP permits WebAssembly compilation.

## Test and evidence

```sh
npm --prefix web test
node scripts/test-browser-openfoam.mjs
```

The production test serves files only, blocks all off-origin and API traffic,
disables WebGPU, imports car geometry through the real UI, and checks computed
fields, wall forces and saved result reopening. It records screenshots and
WebM video under `test-results/browser-openfoam/`. The default test runs Quick
and Fast on the sample car; `EASYCFD_WASM_MODELS=sample` runs Quick alone.
`EASYCFD_WASM_MODELS=sample-detailed` checks the longer Detailed preset.
Set `EASYCFD_WASM_BASE_URL` to check an existing static preview URL instead of
the test's local file server, including a Tailscale Serve preview.
`EASYCFD_WASM_MODELS=mx5,z4,ahmed` uses imported fixtures outside Git under
`.wasm-test-models/{mx5,z4,ahmed}/`, each containing the original project
`record.json` and `geometry-*` folder copied from the Mac Mini.

The test captures actual OpenFOAM case files for native numerical comparison.
It does not use mocked solver data. See `web/VALIDATION.md` for measured runs
and the limits of those checks.

## Source and attribution

OpenFOAM is GPL-3.0-or-later; see `COPYING.OpenFOAM`. The compatibility patch
and Emscripten wmake rules were adapted from
[FoamScience/openfoam-wasm](https://github.com/FoamScience/openfoam-wasm).
`prepare.py` records the additional build adaptations; the finite-volume
numerical equations and supported model implementations remain OpenFOAM code.

The packaged manifest lists `source.chunks`: concatenating those static assets
in order produces `openfoam-wasm-source.tar.gz`, containing the exact patched
OpenFOAM sources and this build toolchain. They are served alongside the GPL
binaries, independently of any external source repository.
