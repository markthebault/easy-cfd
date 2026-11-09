# Browser 2D flow prototype

Open EasyCFD and choose **2D profiles** in the top-left workspace menu, or use
`?workspace=2d`. Everything runs on the visitor's device. This workspace makes
no solver API requests and requires no Python service, WebSocket or server
function. It is included in the normal static Vite build.

The scene includes up to 16 editable closed polygon shapes. Select and drag a
shape to move it, drag the round handle to rotate, or enter position, angle and
width numerically. Shift snaps rotation to 15 degrees. Drawing, primitive shapes
and imported SVGs add geometry alongside existing shapes. Overlapping parts
form the union solid mask used by the solver. Scenes export as multi-polygon SVG,
save locally, and migrate the previous single-profile storage automatically.
The selected shape has an editable name. Each shape has an enable checkbox:
disabled shapes remain editable dashed outlines but are omitted from the solid
mask, forces, tracer collisions and SVG export. Renaming does not restart the
solver; geometry and enable changes do. Names and flags save locally, and their
changes support Undo.

Draw opens Lines, Bézier, Rectangle, Ellipse and Freehand tools. Click to place
corners; in Bézier mode, drag to create tangent handles. Handles remain editable
after closing and saving. Alt allows independent tangent adjustment. Rectangles
and ellipses are drawn by dragging; Shift constrains them to squares and circles.
Freehand simplifies the traced outline. The snapping checkbox controls alignment
to existing geometry. Curves retain their cubic SVG paths on export and use
adaptive sub-cell sampling, including exact extrema, for the solver mask.

A single left click selects a point for dragging. Right-click or double-click
removes a point. Clicking the first point closes a drawn outline; its indicator
has a 4.5 px radius. Closure briefly waits to distinguish a double-click deletion.
Cmd/Ctrl+Z removes the last drawing point, or undoes the last scene change.

In Select, drag empty space to draw a selection box around shapes. Shapes touched
by the box are selected in either drag direction. Shift-drag adds to the existing
selection; Escape cancels a selection box. Drag a selected shape or the group
border to move the whole selection. Shift-click or Cmd/Ctrl+A also selects multiple shapes,
which then share move, rotation and resize handles. Edge handles stretch one
dimension; Shift or Lock proportions preserves aspect ratio. Width and Height
can also be entered numerically. Scroll or use the zoom buttons to zoom around
the pointer; the hand tool, middle mouse, or Space-drag pans without editing
geometry. Reset zoom fits the tunnel. The speed slider covers 0.1× to 3×.

Flow / Pressure / Vortices layers can be combined with flowing smoke, particle
trails, velocity arrows, or colour-field-only playback. Smoke uses the 3D viewer's
GPU midpoint/MacCormack advection approach on a 1024-pixel-wide tracer grid,
with a CPU fallback. Advection is bounded and follows the evolving computed
velocity; it does not add forces. Tracer time advances with solver step time.
Fine core outlines use swirling strength, the imaginary eigenvalue component of
the velocity gradient; unlike vorticity alone, this rejects pure shear.

Rendering and solver updates run independently. Playback speed controls both
solver advancement and flow visualization. Reduced-motion preferences start
playback paused. Pause/Resume is labelled explicitly beside the playback controls;
the default speed is 1×. The browser-status badge, global direction marker and labelled
ground marker are intentionally omitted.

The car preset is traced from the grey silhouette in the user-supplied `Car.png`
CFD screenshot. Its physical preset is calibrated to 4.3 m long × 1.5 m high,
with 150 mm ground clearance, as requested. The screenshot has no measured scale;
this remains an illustrative silhouette. Its arrows and pressure colours
are not used as simulation data. Use `?workspace=2d&profile=car` to explicitly load
this preset; subsequent reloads preserve edits as usual. Older saved scenes keep
their authored metre dimensions and migrate to the medium box. The Size as car
action resizes a selected old car outline to 4.3 × 1.5 m without replacing its
points. Imported SVG width is specified in millimetres and bounded by the active
box, so full-size vehicles are no longer limited to 2,400 mm.

Simulation boxes are Small (3 m long × 2 m high), Medium (7 × 3 m), and Large
(20 × 7 m). Changing the box retains geometry in metres; an incompatible smaller
box is rejected instead of shrinking the shapes. New parts/car scene buttons
provide separate starting examples, with Undo restoring the previous scene.
Zoom to selection makes small parts or a full-size vehicle easier to edit.

The Silhouettes group also includes **MX-5 NC PRHT**, using the `car-body` path
from the supplied SVG. Its white background rectangle is excluded, and the
original cubic anchors and handles remain editable. The file has no physical
scale: the preset starts at an approximate 4 m length and 150 mm clearance,
preserving the trace's proportions. Width, height and clearance remain editable.
Adding it from the small box selects the large box while retaining existing parts.
The Inverted airfoil (rear wing) preset vertically mirrors the existing inclined
section and starts with a 500 mm chord. Its trailing edge rises downstream for
negative lift in the isolated-section check. It can be moved above the rear of
a car, rotated and resized; the car wake and placement can change its actual load.

## Solver and upstream

`web/src/flow2d/lbm.ts` and the fused WebGPU kernel in `gpu.ts` are focused adaptations of the basic D2Q9
equilibrium, BGK collision and streaming equations in
[AeroJAX](https://github.com/arriemeijer-creator/AeroJAX), specifically
`lbm/collision.py`, `lbm/streaming.py` and `lbm/lattice.py` (Arno Meijer, 2026).
It is LGPL-3.0-or-later. The full LGPL and incorporated GPL text are in `licenses/`.
The app's About dialog offers the adapted source and licence notices for download.
The remaining editor and renderer are EasyCFD code. The portable WASM numerical
runtime [@jax-js/jax](https://github.com/ekzhang/jax-js) is MIT licensed. WebGPU
uses the same equations in one fused dispatch per lattice step, with a few MB
of buffers instead of retaining per-operation array intermediates. Browser
checks compare its fields against the portable equations.

This is a new, deliberately limited browser implementation, not the full AeroJAX
Python application. Changes include a flat direction-major array layout, fused
pull-stream/collide, link bounce-back at stationary obstacles, an equilibrium
inlet/top/moving-ground row, a simple zero-gradient outlet, and a serialized
worker protocol. The upstream desktop UI, MRT, neural operators, inverse design
and Reynolds-number rescaling are not included. The interactive wake uses a
standard local Smagorinsky eddy-viscosity term (Cs=0.1) to stabilize the lower
molecular viscosity; it adds dissipation rather than artificial wake forces.

The physical grids use square endpoint spacing in both axes:

| Box | Length × height | Lattice nodes | Cell spacing |
| --- | --- | --- | --- |
| Small | 3 × 2 m | 601 × 401 | 5 mm |
| Medium | 7 × 3 m | 701 × 301 | 10 mm |
| Large | 20 × 7 m | 801 × 281 | 25 mm |

All grids exceed the previous 129,024-node preview. Lattice inlet speed is 0.065;
Smagorinsky Cs=0.1. Interactive molecular relaxation time changes with cell size
according to `liveTau` in `grid.ts`: `(tau - .5) * cellSize` remains constant,
retaining the same illustrative physical molecular viscosity. Portable class
defaults remain tau=0.57, Cs=0; lattice viscosity is `(tau - 0.5)/3`.
There is no road-speed control or claim to match real-air Reynolds number.
The displayed pressure coefficient uses `(rho - 1) * 2 / (3 U_lattice²)`.
The pressure colour range clips at ±2.5 without changing the numerical data.

## Drag and lift comparisons

The Drag & lift panel reports the total force on the exposed union of enabled
shapes using stationary-boundary momentum exchange. At each bounce-back link,
the fluid transfers `2 f c` to the obstacle. Every solver step is integrated,
then reduced on the GPU or by sparse boundary links on WASM. This includes the
simulated pressure and viscous momentum transfer; it excludes outer tunnel
boundaries. See the [momentum-exchange review](https://doi.org/10.3390/e17127876)
and [stationary-boundary discussion](https://pubmed.ncbi.nlm.nih.gov/22400698/).

With lattice density 1, square cell spacing `dx`, inlet speed `U` and fixed
physical reference length `Lref`, the section coefficients are:

`Cd = 2 Fx_lattice dx / (U² Lref)`

`Cl = 2 Fy_lattice dx / (U² Lref)`

Positive drag is downstream; positive lift is upward and negative lift is
downforce. Both coefficients use the same reference length, initially the
starting scene's width. It remains fixed when geometry rotates, resizes or
gains parts. It is explicitly editable under Reference & method. These are
2D section coefficients; they do not use a car frontal area or finite wing span.

Startup discards the larger of one box transit and four reference-length
transits. Every subsequent solver step contributes to a cumulative mean; there
is no two-length rolling window that follows individual wake cycles. Worker
batches stop exactly at startup and flow-block boundaries, independent of the
playback speed. A direct caller that straddles startup loses that whole batch
instead of mixing unknown transient impulses into the sample.

A flow block spans the larger of two reference lengths and one-fifth of the
box length. At least ten blocks are required. A drift diagnostic compares the
first and last halves of completed block means, and the recent quarter with
the cumulative mean. These diagnostic windows grow to 256 blocks, while the
force mean continues accumulating all post-startup steps. Both Cd and Cl must
pass three consecutive block checks before baseline capture is enabled. The Cd
drift tolerance is `max(0.015, 0.03 |mean Cd|)`; Cl uses
`max(0.025, 0.03 |mean Cl|)`. A later drift revokes readiness. These are explicit
interactive sampling tolerances, not a physical accuracy or confidence bound.

The chart and CSV contain cumulative means. The panel distinguishes collecting,
still settling and mean settled, and reports the observed mean drift. Batch RMS
fluctuations remain available in Reference & method: a wake can keep fluctuating
while its mean settles. Pause freezes the displayed measurement. Mesh/domain
and time-resolution checks are still needed before relying on the coefficients.
This follows the general unsteady-CFD practice of monitoring averaged force
statistics, as in [OpenFOAM runTimeControl](https://doc.openfoam.com/2306/tools/post-processing/function-objects/utilities/runTimeControl/).

Save baseline retains the averaged coefficients and geometry locally. Angle,
part and enable changes restart warmup, then show signed coefficient deltas
against that baseline when the new mean settles. A comparison requires the same domain, grid, relaxation,
eddy viscosity, lattice inlet, fixed reference length and backend. Incompatible
settings and older averaging methods suppress deltas. Restore baseline design is undoable. Disabled parts
do not influence measurements; disabling every shape reports zero obstacle force.

Save configuration keeps up to twelve named local design snapshots, including
their geometry and force values. Records captured before the mean settles are
marked provisional and cannot be promoted to a baseline. Saved values stay fixed
as the live simulation advances. Records can be renamed, restored, deleted or
exported together as CSV. Restoring geometry is undoable and starts a fresh force
measurement. The table shows baseline deltas only for settled, matching records.

Use matched settings to explore trends, then check grid/domain convergence and
appropriate benchmark cases before relying on quantitative results. The coarse
mask and illustrative Reynolds regime can change both the magnitude and trend
from a real high-Reynolds-number vehicle or wing. No dimensional force in newtons
is reported because road speed, density and finite span are not specified.

## Limits

This is an exploratory, low-to-moderate-Reynolds-number section study. The coarse Cartesian
solid mask cannot resolve thin edges or boundary layers below a few cells.
The moving-ground row and far-field/outlet boundaries are simplified. The
animation is accelerated for visibility and is not a physical-time recording.
No full-car forces, qualified coefficients or engineering accuracy are claimed.
The port still needs matched upstream comparisons and grid/domain convergence.

SVG currently accepts one closed contour without holes, clipping, text or linked
resources. Imported markup is parsed as geometry, never mounted in the page.
Dimensions are set explicitly in millimetres; geometry and simulation use metres.

## Verification

`npm --prefix web run build`

`cd web && node --test --test-concurrency=1 tests/flow2d.test.mjs tests/flow2d-curves.test.mjs tests/flow2d-grid.test.mjs tests/flow2d-forces.test.mjs`

`cd web && EASYCFD_WEB_TEST_PORT=5199 npx playwright test tests/e2e/flow2d.spec.ts tests/e2e/flow2d-numerics.spec.ts`

`cd web && npx playwright test --config playwright.flow2d.config.ts`

The production suite builds minified static assets and exercises cold startup,
animated field updates, reset and geometry changes in Chromium and WebKit, with
automatic backend selection and forced WASM. The worker build places jax-js and
its GPU backends in one runtime chunk. Keeping them together prevents a GPU
chunk from importing the worker entry again, which split runtime class
identities and failed private-method brand checks on cold startup in WebKit.

The unit checks cover Bézier sampling and extrema, affine curve transforms,
group bounds, freehand simplification, equilibrium preservation, solid-cell velocity masking,
finite splitter evolution, shape transforms, union solid masks, passive tracer
transport, and the distinction between rotating cores and pure shear. Force
checks cover rest-pressure cancellation, an empty tunnel, step-weighted windows,
batch integration, symmetry and lift-sign reversal for a mirrored section, added
parts, and GPU/WASM agreement. Production-browser checks cover shape metadata,
toggles, live measurements, pause, baseline settings, persistence and CSV export.
These are implementation checks, not physical validation.

## Vortex particles

Animation → Vortex particles selects the browser-only vvflow backend while using
this same editor and scene. Enabled polygons are merged into exposed solid
boundaries; edits restart the simulation after pointer release. Particle positions
and signs come from the solver. This mode shows particles only, with no pressure
or LBM force overlay. The viewing box has no physical walls or ground in this mode.
Other animation choices retain the LBM backend and its original controls.
See [the port notes](../../vvflow/README.md) for fixed settings and limits.
