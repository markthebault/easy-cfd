# Browser OpenFOAM validation

Tested on 13 October 2026. The default browser engine is real OpenFOAM v2512
compiled to WebAssembly, using serial SIMPLE, k–omega SST and double precision.
The former WebGPU study is preserved in [WEBGPU-VALIDATION.md](WEBGPU-VALIDATION.md).

## Static runtime checks

The production build was served by a file-only HTTP server. The browser test
blocked API and off-origin requests, disabled `navigator.gpu`, imported geometry
through the UI, and checked pressure/velocity fields, wall forces, surface
samples, saved result reopening, and visualization layers. It recorded the
actual browser session. No solver process or backend was used by these runs.

The same production assets also ran on the user's Mac Mini: Apple M1, 8 cores,
16 GiB RAM. All imported models were closed, consistently wound STL assemblies
from `/Volumes/SSD512/persospace/easy-cfd/.easycfd/projects/`. Their geometry was
not modified. Source models remain outside Git and the shipped static app.

| Model / preset | Cells | Iterations | Whole browser run | Cd | Cl |
|---|---:|---:|---:|---:|---:|
| Sample / Quick, Mac M1 | 21,206 | 180 | 27.6 s | 0.498965 | 0.716661 |
| MX-5 NC / Quick, Mac M1 | 21,191 | 180 | 32.6 s | 0.328759 | 0.045242 |
| BMW Z4, full wing assembly / Quick, Mac M1 | 79,321 | 180 | 105.0 s | 0.475858 | 0.227660 |
| Ahmed body / Quick, Mac M1 | 17,476 | 180 | 20.6 s | 0.550699 | 0.536088 |
| Sample / Fast, final compressed build, Mac M1 | 63,442 | 300 | 104.9 s | 0.510035 | 0.714679 |
| Sample / Quick, final compressed build, Linux | 21,206 | 180 | 28.2 s | 0.498965 | 0.716661 |
| Sample / Fast, final compressed build, Linux | 63,442 | 300 | 106.0 s | 0.510035 | 0.714679 |
| Sample / Detailed, Linux | 348,352 | 1,000 | 1699.6 s | 0.489174 | 0.553821 |
| Sample / Detailed, Mac M1 | 348,352 | 1,000 | 1780.6 s | 0.489174 | 0.553821 |
| Sample / Quick, Tailscale HTTPS static directory, Linux | 21,206 | 180 | 32.5 s | 0.498965 | 0.716661 |

Times include meshing, checking, solving, sampling, and loading static assets.
The Detailed checks used a 30-minute test limit; its final default is one hour
to leave room for larger imported models. Both finished all 1,000 iterations,
passed field/force checks and reopened saved results. The Tailscale check used
Serve's static directory mode, with no application server or solver backend.
They are observations on these devices, not runtime guarantees. Imported runs
used 100 km/h, zero yaw and moving road; wheels rotated on the MX-5 and Z4.
The Ahmed case used the imported project's density and reference area, with
fixed wheels and the UI's default 10 mm simulation gap. It is a runtime check,
not a matched physical Ahmed benchmark.

## Native numerical comparison

Captured browser case files, including the generated mesh, were run with stock
native `simpleFoam` from the pinned OpenCFD v2512 image. Conditions, schemes,
iteration limits and the last-50-iteration averaging window were identical.
OpenFOAM's native `forceCoeffs` output was compared to the browser adapter.

| Case | Absolute Cd difference | Absolute Cl difference |
|---|---:|---:|
| Sample Quick | 1.94e-15 | 3.11e-15 |
| Sample Fast | 1.30e-14 | 3.22e-15 |
| MX-5 Quick | 1.72e-15 | 1.67e-16 |
| Z4 Quick | 2.56e-9 | 1.45e-8 |
| Sample Detailed | 2.20e-6 | 3.18e-5 |

All are below the 1e-4 coefficient tolerance. This establishes numerical
agreement with native OpenFOAM on the same browser meshes. It does not establish
physical aerodynamic accuracy or agreement with a much finer native mesh.

## Mesh and feature limits

Quick has a 100,000-cell ceiling and 180 iterations; Fast has a 220,000-cell
ceiling and 300 iterations. Detailed uses finer surface and wake refinement,
a 600,000-cell ceiling and 1,000 iterations, with a 60-minute whole-job limit.
Cell ceilings are limits, not fixed mesh sizes. All presets stop on mesh-check
failure or unresolved car parts. Fast and Detailed request one prism layer,
but actual coverage is reported; the
sample Fast mesh obtained no retained prism layers. The sample Detailed mesh
retained layers on 98.2% of its car wall. Surface, gap, and wall
resolution can materially affect lift, drag and axle loads. A settled force
history and low residuals do not establish grid independence.

The adapter preserves the complete case between OpenFOAM tools. Layer meshing
can write moved points in `0/polyMesh`; transferring only `constant/polyMesh`
created an invalid reconstructed mesh during development. Both presets passed
OpenFOAM mesh checks after that transfer was corrected.

Advanced meshes and physical-time recordings use the existing connected
OpenFOAM backend. Browser results, comparisons, exports and saved runs retain
the existing viewer contracts. Old WebGPU results still reopen. Browser runs
have no WebGPU numerical fallback.

The four compressed modules total approximately 15.3 MiB, with raw static
fallback chunks for browsers without `DecompressionStream`. Every asset is
at most 8 MiB, below Cloudflare Pages' 25 MiB file limit. The matching GPL source
archive and license are served with the binaries.

Validation also passed 63 unit tests, the browser preset selection/time-limit
checks, the browser results/group/friction and
cancellation checks, native/remote API UI checks, and a real HTTPS-frontend
connection to the existing Docker backend.

Screenshots, unedited MP4 recordings and machine-readable checks are in
[the evidence bundle](../docs/browser-openfoam/README.md). Reproduce the static
browser checks with `node scripts/test-browser-openfoam.mjs`, and native parity
with `python3 scripts/compare-wasm-native.py <captured-run-directory>`.
