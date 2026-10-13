# Browser OpenFOAM evidence

The isolated worktree is based on origin/main commit
`5fb0cb09a1a3b4bfa99203d4956f3dc199bc0933`. It replaces the public WebGPU run
path with OpenFOAM WebAssembly, while keeping the native/remote API and viewer
contracts. Quick, Fast and Detailed are the browser presets; Detailed has a
600,000-cell ceiling and 1,000 iterations.

The file-only production test disables WebGPU and blocks API/off-origin
requests. The Mac Mini checks cover the MX-5, Z4 with all wing parts, and Ahmed
body, including computed fields, per-part wall values and saved result reopening.
[Machine-readable Mac checks](mac-verification.json) include hardware, timings,
coefficients and request records. [Native parity](native-parity.json) compares
four captured meshes with stock OpenFOAM v2512.

## Screenshots

![MX-5: computed pressure and forces](mx5-results.png)

![MX-5: computed streamlines](mx5-streamlines.png)

![Z4 and wing: computed pressure and forces](z4-results.png)

![Z4 and wing: computed streamlines](z4-streamlines.png)

![Fast browser preset](fast-results.png)

## Unedited recordings

- [MX-5 static OpenFOAM run](mx5-static-openfoam.mp4)
- [Z4 static OpenFOAM run](z4-static-openfoam.mp4)

These are browser recordings converted to H.264 without changing playback
speed. They show the actual import, local solve, results, visualization and
reopening. Streamline/particle movement displays the computed steady field;
physical-time wake recordings require the connected backend.

The native comparisons establish equivalence on these meshes. Light meshes
still need grid and physical validation before design claims. The sample Fast
case retained no prism layers; its warning and measured coverage are preserved.
See [the full validation notes](../../web/VALIDATION.md).

## Hosting and reproduction

`VITE_ENABLE_OPENFOAM=false npm --prefix web run build` produces `web/dist/`.
Host the entire directory statically, including `openfoam/`. No API, Cloudflare
Function or compute backend is required for the browser engine. Modules are
precompiled, compressed, checked by SHA-256, and loaded into a local worker.

The native backend connection flow was also checked from an HTTPS static
frontend against the existing Docker backend. No production deployment or main
worktree change was made.
