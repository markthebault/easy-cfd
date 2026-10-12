# EasyCFD Web

A virtual wind tunnel served as static files. OpenFOAM WebAssembly meshes and
solves airflow locally in your browser. A token-protected OpenFOAM backend
remains available for advanced meshes and physical-time recordings.

## Run and host it

```sh
cd web
npm ci
npm run dev
```

The checked-in static OpenFOAM assets are under `public/openfoam/`. Rebuild them
with `npm run build:wasm` when changing OpenFOAM or its sampling adapter. That
build uses Docker; running the website does not. See [the build guide](../wasm/README.md).

```sh
VITE_ENABLE_OPENFOAM=false npm run build
```

Host the complete `dist/` directory on Cloudflare Pages or another static HTTPS
host. No API, Cloudflare Function or solver server is required for browser
runs. WASM binaries are split into files smaller than 8 MiB; the worker checks
and combines them locally. Serial runs need no cross-origin isolation headers.
Opening the app directly from `file://` is unsupported because it uses modules
and workers. WebGPU is not required; WebGL still renders the 3D scene.

## Use it

1. Import STL, OBJ, GLB or glTF, or load the sample car. Check units, axes,
   clearance, part groups and the wheel roles and radii. Confirm the checklist.
2. Set speed, yaw, density, reference area, road and wheel motion, and the
   automatic or custom tunnel box.
3. Choose **OpenFOAM · Browser** and **Quick** or **Fast**. These are bounded
   light meshes. The worker runs real `blockMesh`, `snappyHexMesh`, `checkMesh`
   and the OpenFOAM SIMPLE / k–omega SST solver in double precision. It reports
   live force history and computed flow snapshots. Keep the tab open.
4. Inspect pressure, wall friction, streamlines, smoke, sections, wake, total and
   per-group forces, and axle loads. Save, reopen, compare, and export as before.
   Forces average the last 50 iterations; surface fields are the final snapshot.
5. For advanced refinement and recorded transient flow, connect an OpenFOAM
   backend URL in Run and select **OpenFOAM · Server**. Its existing levels and
   API remain unchanged. Those runs upload geometry to that backend and continue
   if the tab closes.

Only enabled groups enter a browser mesh. Different designs can generate
slightly different meshes; grid sensitivity must be assessed separately. Small
parts and gaps may exceed the light preset's mesh budget and require a server.
Old WebGPU results still open; their designs migrate to browser OpenFOAM when
rerun. There is no WebGPU fallback for a failing WASM run.

## Integration and validation

- `src/engine/wasmCase.ts`: OpenFOAM dictionaries and geometry in the UI frame.
- `src/workers/openfoam.worker.ts`: static module loading, meshing, checking,
  solving and sampling. It makes no backend requests.
- `src/engine/wasmResults.ts`: the same `RunResult`, `VizField` and
  `SurfaceSample` contracts used by the server adapter.
- `src/engine/openfoam.ts`: existing native/remote server adapter.
- `src/store/runs.ts`: saves both engines in the existing browser library.

```sh
npm test
node ../scripts/test-browser-openfoam.mjs
```

The production browser test blocks API/off-origin requests and disables
WebGPU. It records screenshots, videos and real case files, checks computed
fields and forces, and reopens saved results. Native comparison uses the exact
browser-generated mesh with stock OpenFOAM v2512. See [VALIDATION.md](VALIDATION.md).

The old WebGPU solver and validation tools remain in the source tree for
historical comparisons; they are not the browser simulation engine.
