# EasyCFD technical guide

EasyCFD has two OpenFOAM runtimes: WebAssembly on the visitor's device and a native backend for advanced analysis. The 3D scene uses WebGL. Browser runs need only static files; see [the browser guide](web/README.md), [WASM build instructions](wasm/README.md) and [measured validation](web/VALIDATION.md).

## Start

```sh
just run            # static frontend on http://127.0.0.1:4173
just run-openfoam   # frontend and native server on http://127.0.0.1:8000
just deploy-web     # publish the static frontend
```

Use Node.js 22+ and Python 3 for `just run`. Alternatively, run `npm ci` and `npm run dev` in `web/`. Production builds need a modern browser with WebAssembly, workers and WebGL. Serve `web/dist` over HTTPS or localhost; modules and workers cannot run directly from `file://`.

## Using it

1. Import STL, OBJ, GLB or glTF, or load the sample. Check units, orientation, wheel roles and road clearance. Confirm the checklist.
2. Set wind speed, yaw, reference area, density, road and wheel motion, axles and the automatic or custom simulation box. Setup smoke illustrates geometry; result views use computed flow.
3. Choose Browser OpenFOAM: Quick (180 iterations / 100,000-cell ceiling), Fast (300 / 220,000), or Detailed (1,000 / 600,000). Their whole-job ceilings are 5, 10 and 60 minutes. Keep the tab open while meshing and solving.
4. Explore pressure, wall friction, streamlines, smoke, sections, wake, component forces and axle loads. The force-history axis and averaging windows use iterations. Saved results can be reopened, compared and exported as JSON, CSV or PNG.
5. Connect a native OpenFOAM server for advanced meshes and physical-time recordings. Server runs continue when the browser tab closes.

## Two OpenFOAM runtimes

Browser OpenFOAM uses OpenCFD v2512, double precision, serial SIMPLE and k–omega SST. Static WASM modules run `blockMesh`, `snappyHexMesh`, `checkMesh` and the solver in a worker. Native wall integrals and computed flow samples map into the shared viewer contract. No solver fallback runs after a WASM failure.

The native server uses OpenFOAM v2412. The published Docker image bundles OpenFOAM and MPI, runs solver processes inside the container and requires no Docker socket. See [the copyable startup command and remote connection guide](README.md#run-an-openfoam-backend-with-docker) and [image publishing](docs/docker-backend.md).

`VITE_ENABLE_OPENFOAM=true` enables automatic same-origin discovery. Static builds use `false` and make no automatic API requests. Remote connections remain available in both builds: enter a token-protected URL in **OpenFOAM server connection**. Browser runs keep geometry on the device; server runs upload it to the selected backend. Tokens stay in session storage and are omitted from exports.

Standard native recordings use URANS and 48 physical-time frames. Detailed wake uses DDES and dense recorded sections. See [recording validation](docs/fine-airflow/README.md).

## Static deployment

Cloudflare's native GitHub integration connects Pages project `easy-cfd-github` to `markthebault/easy-cfd`. Every push to the production branch `main`, including a merged pull request, builds and deploys https://easy-cfd.mthracelab.com. All other branches build previews. Cloudflare posts preview links on pull requests and reports build status through its GitHub integration; each deployment also has an immutable URL under `easy-cfd-github.pages.dev`.

The production and preview build settings are the same: root directory `web`, command `npm run build`, output directory `dist`, `NODE_VERSION=22` and `VITE_ENABLE_OPENFOAM=false`. Native discovery remains disabled, while user-configured remote OpenFOAM connections are available on both production and preview sites. The native integration does not require Cloudflare credentials in GitHub Actions secrets or a deployment workflow. Build settings and branch controls are managed in the Cloudflare Pages dashboard.

The old `easy-cfd` Direct Upload project remains as a rollback copy. Cloudflare does not convert Direct Upload projects to Git integration, so the Git-connected project uses a separate name and serves the existing custom domain. `just deploy-web` remains a manual fallback for the new project: it builds `web/dist-static` and uploads it with Wrangler, loading the API token from `~/.env.cloudflare` after building. Set `EASYCFD_PAGES_PROJECT=easy-cfd` to upload to the old rollback project explicitly. Cloudflare credentials are never bundled into the frontend.

## Numerical limits

The validation suite checks actual meshing/solving, finite computed fields, native parity on identical meshes and saved-result reopening. These checks do not establish physical accuracy or grid independence. Light meshes may miss small gaps or thin surfaces; advanced cases belong on the server. Force settling, residual convergence and mesh sensitivity are separate checks.

The retired browser solver, numerical shaders, benchmarks and compatibility UI have been removed. Results from a retired solver are excluded from the run library; model designs remain available for a fresh OpenFOAM run. No stored user data is deleted.

## Development checks

```sh
uv run pytest -q
npm --prefix web test
npm --prefix web run build
VITE_ENABLE_OPENFOAM=true npm --prefix web run test:e2e
VITE_ENABLE_OPENFOAM=false npm --prefix web run test:e2e -- tests/e2e/edition.spec.ts tests/e2e/remote-openfoam.spec.ts
node scripts/test-browser-openfoam.mjs
```

The browser integration suite uses real WASM runs and mocked server responses for API/UI checks. Optional tests require locally retained car fixtures, native recordings or a rendered video. The production static test blocks API and off-origin requests, disables the removed compute API, checks actual fields and saves screenshots, videos and browser-generated cases.

## Original native UI

`backend/`, `frontend/` and `scripts/` retain the original native workflow at `/legacy/`, including STEP import, opening repair, merge/seal and transformations. See [its guide](docs/legacy-openfoam.md). This is a native OpenFOAM UI, independent of the removed browser solver.

## Private Tailscale access

```sh
tailscale serve --bg --https=8444 http://127.0.0.1:4173
# Or serve a built static directory directly:
tailscale serve --bg --https=8443 /absolute/path/to/web/dist
```

Browser computations run on the visitor's device. Native computations run on the backend. Designs are stored per browser. Stop the corresponding listener with `tailscale serve --https=8443 off`.

## Licenses

Application code and original sample geometry are MIT-licensed. Browser OpenFOAM is GPL-licensed; matching source and license notices accompany the static assets. See [THIRD_PARTY.md](THIRD_PARTY.md).
