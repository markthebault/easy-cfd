Watch [the 80-second walkthrough](repair-walkthrough.mp4). The recording uses the real browser UI and API, with explanatory captions. It shows rim inspection, selective cap preview, reset, both caps, rotation, apply, and STL download.

The source is a copy of the existing prepared BMW Z4 from local project `10da02eb36f54ceaa02e2ad92bac29c7`. Two planar surface regions were deliberately removed, on the bonnet and roof. The original internet download was not located. This demonstration does not show that the original download can be repaired by these operations.

The fixture has two openings on its body. Applying both adds 110 triangles without moving any existing vertices. All 12 exported parts passed watertightness, winding, and positive-volume checks. Their vertex coordinates exactly match the corresponding pre-repair fixture parts. Existing geometry checks report no errors. No OpenFOAM mesh or simulation was run for this demonstration.

Validation: 44 backend tests passed, Ruff passed, and the frontend production build passed. A real API/browser test checked preview, reset, apply, reopening, export availability, Escape, and a 390-pixel viewport. The recording reported no browser exceptions. The build retains the existing large JavaScript bundle warning.

The prototype runs separately at http://127.0.0.1:8010 with data in `/tmp/easycfd-repair-demo`. Existing user projects were only read. Changes are on branch `feat/selective-hole-repair`.

Subsequent transform tools preserve applied repairs, and merge/seal provides separate whole-model reconstruction with a before/after comparison. Curved patch repair remains unsupported. The current triangulation handles concave planar rims instead of relying on the library's [triangle/quad-only hole filler](https://trimesh.org/trimesh.base.html#trimesh.base.Trimesh.fill_holes).
