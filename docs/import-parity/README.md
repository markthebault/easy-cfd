# Original model import comparison — 9 October 2026

AirShaper accepted and rendered all seven supplied original files through Computer Use after the user signed in. EasyCFD now imports those same files and completes a quick OpenFOAM mesh check and 50-iteration run on their original surfaces. None of these seven validation runs uses sealing, voxel reconstruction or an estimated exterior. No AirShaper simulation was started or ordered.

Sources: `~/Library/Mobile Documents/com~apple~CloudDocs/Docs/CFD/Internet Models/`. Downloaded local copies were used for iCloud placeholders. Source files are unchanged. Tests use an isolated backend at http://127.0.0.1:8782/ with data under `/tmp/easycfd-import-parity/data`; the existing persistent preview service and its data were preserved.

| Example | Original file | AirShaper import | Original triangles in EasyCFD | OpenFOAM cells | Run time |
| --- | --- | --- | ---: | ---: | ---: |
| Audi A4 | `sedan.stp` | Accepted | 93,210 | 10,302 | 13.5 s |
| Tesla Model S | `Tesla_base.stp` | Accepted | 157,308 | 9,514 | 23.3 s |
| Porsche 919 Evo | `919_EVO.stp` | Accepted | 364,108 | 11,057 | 12.8 s |
| Mazda RX-8 | `Mazda RX-8 Racecar Model.stl` | Accepted | 299,998 | 10,330 | 8.9 s |
| Porsche 718 Cayman GT4 | `2020 Porsche 718 Cayman GT4.obj` | Accepted | 405,053 | 10,326 | 9.8 s |
| Dodge Challenger | `challenger3.igs` | Accepted | 872,812 | 10,364 | 13.6 s |
| Porsche 987 aero package | `Endplate.step` | Accepted | 340 | 19,751 | 11.5 s |

All seven passed `checkMesh` and completed 50 solver iterations. Times are saved solver start-to-finish, excluding import, CAD tessellation, server geometry preparation and viewer loading. The endplate is the only geometry file supplied in its folder. CAD surfaces are triangulated from the source rather than reconstructed; mesh files retain their surface triangles. Units, orientation and placement above the road remain explicit, editable choices. The Mazda model is approximately 1.16 m long with metre units in both viewers.

## EasyCFD fixes

- STEP/STP and IGES/IGS work in the main browser importer, including the WebGPU edition. Conversion runs locally in a worker with bundled `occt-import-js` assets and a five-minute limit. Embedded CAD units are respected. Zero-area slivers produced by Float32 conversion are omitted, not replaced with new surfaces.
- The original Cayman OBJ mixes faces with decorative lines and points. Three.js previously reclassified some objects as lines and omitted body panels. Ignoring only those non-surface records retains all 405,053 triangles.
- Open edges, disconnected surfaces and inconsistent winding are review warnings rather than an automatic prohibition. The importer preserves those surfaces. Non-finite geometry, unusable geometry, invalid wheel axes and clearance errors remain blocking.
- The quick check concatenates enabled original surfaces into one OpenFOAM assembly. This preserves every selected triangle and intentional gap while avoiding a mandatory separate mesh patch for each tiny OBJ fragment. Wheels remain fixed for this check. Normal runs retain separate parts and wheel settings.
- Open panels no longer trigger impossible thickness refinement. The quick preset caps small closed-feature refinement at level 3 and reports underresolved features. Its 0.95 m background spacing, no wake refinement, no layers, 120,000-cell ceiling, 50 iterations and 180-second limit are lighter than Fast. OpenFOAM mesh-quality checks remain enabled.
- Normal runs report small, internal or sheltered parts with fewer than six fluid-facing mesh faces as resolution warnings, with per-part face counts saved in the result. The original Challenger Fast run passed `checkMesh` with 35,097 cells but was previously rejected because a CAD patch had only one face. The completed retry records 13 nonempty patches with one to five faces and 35 parts with no fluid-facing faces. EasyCFD no longer rejects an OpenFOAM-passing mesh on patch face counts. Zero-face parts contribute no forces; sparse-part forces and local flow need resolution review.
- Automatic thin-detail refinement is bounded to two levels beyond the preset's surface level instead of rejecting thin source parts. Fast uses at most level 4; the quick check remains at most level 3. The estimated requested level, actual level and underresolution flag are saved per part, and normal runs report capped detail refinement. This changes volume mesh resolution, not source model geometry; OpenFOAM quality checks still run.
- Large assemblies are sampled once and values mapped back onto their original browser parts. Native wall-stress matching now runs in bounded batches, fixing the original Challenger's viewer memory failure without raising memory limits or changing sampled values.
- The viewer renders both sides of original surfaces. Inward-facing Challenger panels had looked like missing roof and door geometry even though their triangles were present. This is a display change; vertices and face winding are unchanged.
- Failed imports preserve the current design and show a persistent error; progress identifies the file being read.

`Prepare for OpenFOAM` remains an optional, explicit tool that changes a separate copy. It was not used for any run in the table. Earlier prepared Cayman and Challenger experiments are superseded and retained only for traceability in [validation.json](validation.json).

These checks establish import and run compatibility for the seven supplied files. The deliberately coarse results remain diagnostic; small-feature resolution, leakage and convergence still need checking before using forces for design decisions. Import acceptance was the AirShaper comparison; aerodynamic results were not compared.

## Evidence

[validation.json](validation.json) records run IDs, settings, dimensions, triangle counts, mesh checks, timings and warnings. [airshaper-drafts.json](airshaper-drafts.json) links the seven accepted source-file drafts.

- Original comparison checkout: 122 backend tests and 67 browser tests passed.
- Isolated PR on current main: 120 backend tests and 61 browser tests passed; Ruff passed.
- OpenFOAM and WebGPU production builds passed.
- Computer Use: all seven AirShaper originals visibly accepted; EasyCFD originals imported; original Cayman and Challenger solver results opened; Challenger result saved and reopened in the rebuilt production app; original roof and door surfaces visibly retained.
- `git diff --check` passed.

![Original Challenger accepted in AirShaper](airshaper-challenger.jpg)

![Original Challenger after quick OpenFOAM check in EasyCFD](challenger-original-openfoam.jpg)

![Original Cayman after quick OpenFOAM check in EasyCFD](cayman-original-openfoam.jpg)

## Challenger Fast retry on Tailscale

The user-reported failed run `8f05d83433b0476ea414d50590768a37` was repeated as `547b82619a57407cba75f3e42f56ed21` on the persistent preview with the exact same settings, all 60 imported parts and all 872,812 original triangles. Every source STL was byte-checked against the failed snapshot. It passed `checkMesh` on 35,097 cells, completed 300 iterations and saved the coverage diagnostics. No model reconstruction or simplification was used. See [retry evidence](challenger-fast-retry.json). The updated backend passes 126 tests and Ruff.
