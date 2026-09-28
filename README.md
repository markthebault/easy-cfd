# EasyCFD

A virtual wind tunnel for cars. Drop in a car, choose a speed, and the airflow is computed on your own graphics card through WebGPU, in the browser. The browser version needs no server, Docker or OpenFOAM: it is a folder of static files, and your geometry never leaves the computer. For final, more precise numbers, the same UI can send a run to the OpenFOAM engine on your EasyCFD server.

![EasyCFD in the browser: smoke over the car, force history and drag breakdown](docs/easycfd-web.png)

The browser version in [`web/`](web/README.md) is the primary EasyCFD tool. The original OpenFOAM app keeps running unchanged; its UI is now at `/legacy/`, and its solver is the optional [OpenFOAM engine](#two-engines-webgpu-and-openfoam) of the new UI.

## Start

```sh
just run            # WebGPU only: builds web/ and serves http://127.0.0.1:4173 (static files)
just run-openfoam   # WebGPU and OpenFOAM: http://127.0.0.1:8000 (original UI at /legacy/)
```

`just run` needs Node.js 22+ and Python 3 (for the static file server). It installs the npm packages on first use. Open the page in Chrome or Edge 113+, or Safari 26+. The app tells you if WebGPU is missing, or if the browser only offers a slow software fallback. Without `just`: `cd web && npm install && npm run build`, then serve `web/dist` from any static web server over `https://` or `http://localhost`.

## Using it

1. **Car.** Drop STL, OBJ, GLB or glTF files anywhere on the page, or open the sample car. Set units, which way the nose points, which way is up, and road clearance. Check the wheels and confirm the checklist.
2. **Conditions.** Road speed (5–300 km/h), crosswind yaw (±20°), reference area (with an exact frontal-area estimate), air density, moving road, rotating wheels, and an automatic or custom tunnel box.
3. **Run.** Fast (about 1 minute on an Apple M1), Medium (1–2 minutes), Precise (two grid levels, 3–5 minutes) or Custom. The flow develops live on screen while the forces converge. Cd and Cl are shown as a moving average over the last 1–10 flow passes (you choose), with the min, median and max over that window.
4. **Results.** Lift or downforce in kg and N, drag, Cd and Cl with a ± band, where the drag comes from, force history and warnings. Visualise surface pressure, smoke, streamlines, a section plane and the wake volume.
5. **Compare.** Two runs side by side with synchronised cameras, shared colour scales, force deltas and the parts or groups that differ.

Designs and runs are saved in the browser (IndexedDB). Runs can be exported as JSON with a CSV of the force history, and views as PNG.

### Two engines: WebGPU and OpenFOAM

The Run step offers two engines:

- **WebGPU:** on this device, seconds to minutes. This is the default. Use it to explore and compare designs.
- **OpenFOAM:** a *final check* on the EasyCFD server, minutes to an hour. It uses snappyHexMesh with prism layers and simpleFoam, the legacy app's pipeline, with its Fast, Medium and Precise presets, their cell budgets and the run times measured on this server.

OpenFOAM is available when the page is opened from `just run-openfoam`. From `just run` or other static hosting, the choice explains how to enable it.

With OpenFOAM, the UI:
- uploads the car to the server, once per geometry;
- switches the parts on and off to match your groups and sends the same conditions;
- shows the solve live: stage, iterations, and Cd and Cl with the moving-average statistics.

When the run finishes, the UI fetches the flow field and surface pressure. The result then works like any other: smoke, streamlines, slice, wake, surface colours, Compare and export. A WebGPU and an OpenFOAM run of the same design can be compared side by side; Compare names the solver difference.

The server keeps the run if you close the tab. The run list's **OpenFOAM server** tab opens it later, together with runs made in the original UI.

What OpenFOAM runs don't have:
- **Live 3D flow:** OpenFOAM writes the field only at the end.
- **Per-group forces:** the case records body and wheel forces only.
- **WebGPU-only settings:** Custom quality and detail cells.

### Part groups: test variants without re-importing

Parts are organised in groups that are switched on and off together, so several versions of a part can live in one design:

- **Automatic groups.** Body and Wheels. Aero parts are recognised by name (wings, endplates and wing supports go into "Rear wing"; also splitters and diffusers). Every file added with **Add parts** gets its own group.
- **Your own groups.** Click a group's name to rename it. Use **New group**, or the menu on each part row, to move parts into another group. Deleting a group returns its parts to their automatic groups.
- **Switches.** A part is simulated when both its own switch and its group's switch are on. **Only this** switches one optional group on and the other optional groups off; Body and Wheels are left alone. This is the quick way to cycle through wing versions.
- **Runs remember their groups.** Results, the run list and **Compare** name the groups each run simulated, for example "Groups: Wing A · 12°" against "no optional groups".
- **Same grid for every variant.** Every part whose own switch is on shapes the grid, also when its group is switched off. All variants of a design therefore run on identical cells, and a difference between two runs comes from the geometry, not from where the surfaces happen to fall in the cells. Compare says whether two runs shared a grid.
- **Forces per group.** Results list the downforce and drag of each group (hover a row for its parts); Compare shows them side by side with the change.

Typical workflow: import the car, then add three rear-wing versions with **Add parts** (each becomes a group). Run the baseline with the wing groups off, then **Only this** on each wing in turn, and compare the runs.

[![Part groups walkthrough: three rear-wing versions run and compared](web/docs/groups-walkthrough.gif)](web/docs/groups-walkthrough.mp4)

[Watch the part-groups walkthrough](web/docs/groups-walkthrough.mp4) (2 min 20 s; the three solver runs are sped up 6×). It uses the synthetic demo geometry in [`web/demo/groups`](web/demo/groups/README.md).

## Accuracy

The browser solver was checked against the OpenFOAM app on eight cases, using the same geometry and conditions: the sample car (also at 10° yaw and with a rear wing), an MX-5, two BMW Z4 versions, a simple one-piece car and the Ahmed body. Drag is within ±10 % of OpenFOAM Medium for 6 of 8 cases on Fast, and 5 of 8 on Medium and Precise. All are within 16 %. On average the browser's drag is about 9 % lower. Lift is less reliable: it is 0.2–0.3 off in Cl on four models. The full tables, sensitivity studies and reproduction steps are in [web/VALIDATION.md](web/VALIDATION.md).

On the sample car in the app: Fast gave Cd 0.511 ± 0.006 and Cl 0.839 in 61 s; Medium gave Cd 0.513 ± 0.001 and Cl 0.845 in 108 s. OpenFOAM Medium gives Cd 0.547.

### Aero parts: wings, splitters, canards, vents

What the browser version gives you for aero variants:

- **Same grid for every variant.** Switching a group off does not change the grid, so two variants are compared on identical cells.
- **Forces per group.** You get each group's own downforce and drag.
- **Thin parts.** Parts thinner than about 1.5 cells are zero-thickness walls with their true outline and angle.

**Experimental detail cells.** Switched on in the Run step, off by default. They refine the grid 2–4× around thin or small parts (set per group: Detail auto, always, off) and inside **detail boxes** defined in Conditions, for vents or holes inside a larger part.

Checked against OpenFOAM on the MX-5 with synthetic wings, a splitter and canards (details in [web/VALIDATION.md](web/VALIDATION.md#aero-parts-synthetic-kit-on-the-mx-5)):

- **Downforce.** The downforce a wing adds is under-predicted: a third to a half of OpenFOAM's change. A 4° and a 10° wing were not ranked correctly by downforce.
- **Drag.** The drag a wing adds is within a factor of about two of OpenFOAM's: 111–238 % without detail cells, 59–95 % with them.
- **Why detail cells are off by default.** They did not bring the results closer to OpenFOAM, they cost 3–6× the run time, and on two of the three older wing validation cars they changed the body flow (the sample car's slant) or made the run unstable (BMW Z4).
- **How to use it.** Use the browser version to set up and screen aero variants on identical grids and to see each part's own force. Treat downforce differences between wing versions as indicative only, and decide between wings with the OpenFOAM version. Improving wing downforce needs a better near-wall model for small parts; that is the next step.

### Lift that does not settle on fine grids

On fine grids some cars have no steady answer for lift. On the simple car at 120 cells per car length, lift keeps swinging between about 0.15 and 0.44, with a period of 8–10 flow passes, while drag stays within about ±3 %. At 72 cells per length the same car converges: lift settles at 0.22–0.25. The finer grid resolves an unsteady wake that the coarser grid damps. Gentler local time stepping ran twice as slowly and still fluctuated (0.13–0.35) around the same mean, so this is the flow, not a solver setting.

What the app does about it:

- Medium, Precise and Custom runs extend themselves by up to 10 flow passes (or twice their length, if shorter) while Cd or Cl is still drifting, then average over the longer window. Fast is never extended.
- Cd and Cl are shown with a ± band: half the range of six sub-window means over the averaging window.
- A run counts as **settled** when the mean of Cd and Cl no longer drifts between the two halves of the averaging window. This is the same test that stops the extension, so a settled run can still oscillate by its ± band.
- The live view and the results show a moving average of the last X flow passes (1, 2, 3, 5 or 10), drawn in bold over the raw history. A table gives the mean, min, median and max of Cd and Cl over that window.

How to read it: use 72–100 cells per car length for design comparisons. Compare designs on drag first, and treat lift differences smaller than the ± band as noise. At 120+ cells, report the average and its band.

## How the solver works

Steady incompressible RANS with the k-ω SST turbulence model, the same model and boundary conditions as the OpenFOAM version: a fixed-velocity inlet with 1 % turbulence, a fixed-pressure outlet, freestream sides, a symmetry top, a moving road, rotating wheels and wall functions. It uses a stretched Cartesian grid with cut cells, so sloped and curved surfaces are smooth rather than stepped. Small cut cells are merged with a neighbour, and thin parts such as wings are zero-thickness walls. The flow is marched to a steady state with local time steps and a multigrid pressure solver, all as WebGPU compute shaders. See [web/README.md](web/README.md) for details and development commands.

## Legacy OpenFOAM version

The original app is in `backend/`, `frontend/` and `scripts/`. It runs OpenFOAM v2412 in Docker. Its UI is at http://127.0.0.1:8000/legacy/, and it still has the tools the new UI does not have yet: STEP import, opening repair, merge & seal, and rotate & scale. Projects uploaded from the new UI appear there too.

```sh
./scripts/setup.sh    # first time: Python/JS dependencies, both UIs and the pinned OpenFOAM image
just run-openfoam     # or ./scripts/start.sh; rebuilds the web UI on each start
```

The backend additions for the new UI (live force coefficients, the flow field and surface values resampled for the viewer, run geometry as STL) are in `backend/easycfd/webview.py`. They only read saved solver output and leave the solver pipeline unchanged.

Its full documentation is in [docs/legacy-openfoam.md](docs/legacy-openfoam.md).

## Private Tailscale access

Both versions can be shared privately on your tailnet (Tailscale Serve, not public Funnel):

```sh
tailscale serve --bg --https=8444 http://127.0.0.1:4173   # WebGPU only (while `just run` is running)
tailscale serve --bg --https=8443 http://127.0.0.1:8000   # both engines, original UI at /legacy/
```

With WebGPU, the flow is computed on the viewer's device, not the host; with OpenFOAM, on the host. Designs are stored per browser. Stop sharing with `tailscale serve --https=8444 off`.

## Licenses

Application code and the original sample geometry are MIT-licensed. The browser version depends on three.js (MIT), React (MIT) and lucide-react (ISC). The legacy version runs OpenFOAM, a separately distributed GPL component in its upstream container. See [THIRD_PARTY.md](THIRD_PARTY.md).
