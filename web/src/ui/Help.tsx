// Built-in guide (preparing a model in Blender) and an honest description of the solver.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useStore } from "../store/store";
import { app } from "../store/app";

function Guide() {
  return (
    <div className="help-body">
      <p>Three steps: <b>Car</b>, <b>Conditions</b>, <b>Run</b>. Drop files anywhere on the page to import them. Everything runs in this tab; nothing is uploaded.</p>
      <h3>Preparing a car in Blender</h3>
      <ol className="guide">
        <li>
          <b>Real size.</b> Scene Properties → Units: Metric, Unit Scale 1.0, Length in metres. A car should measure about 4 m in Item → Dimensions. Then select everything and use Object → Apply → Rotation &amp; Scale.
        </li>
        <li>
          <b>Separate wheels.</b> One body object and one object per wheel, named e.g. <code>wheel_front_left</code>. Names containing wheel, tyre, tire or rim are detected as wheels. Keep every part in its assembled position.
        </li>
        <li>
          <b>Closed surfaces.</b> Each part should enclose a volume: seal the cabin and openings you are not studying, give thin wings some thickness, and avoid wheels touching the body. Check with Select → Select All by Trait → Non Manifold, then Mesh → Normals → Recalculate Outside.
        </li>
        <li>
          <b>Export STL.</b> File → Export → STL with Selection Only, Batch (one file per object), ASCII off, Scale 1.0 with Scene Unit on, Apply Modifiers on. Keep the same Forward/Up settings for every part.
        </li>
        <li>
          <b>Import here.</b> Select all files at once. Pick the units and the axis the nose points to, check that the FRONT label sits at the nose and the airflow arrow points from nose to tail, set a plausible road clearance, and mark the four wheels.
        </li>
      </ol>
      <h3>Reading the results</h3>
      <ul className="guide">
        <li><b>Downforce</b> (kg) pushes the car onto the road; negative Cl means downforce. <b>Lift</b> is the opposite.</li>
        <li>Use <b>Fast</b> to check the setup and <b>Medium</b> or <b>Precise</b> before comparing designs. Compare runs with the same speed, reference area and quality.</li>
        <li>A <b>Provisional</b> badge means forces were still moving at the end: run longer (more passes) before trusting small differences.</li>
        <li>The <b>Slice</b> in Cp0 and the <b>Wake</b> surface show where the air loses energy. A smaller wake usually means less drag.</li>
      </ul>
      <h3>Controls</h3>
      <ul className="guide">
        <li>Drag to orbit, right-drag or two-finger drag to pan, scroll to zoom. Click a face of the orientation cube to snap the camera.</li>
        <li>Coloured knobs in the view move the smoke rake, the streamline rake and the slice.</li>
      </ul>
    </div>
  );
}

function Solver() {
  return (
    <div className="help-body">
      <p>
        EasyCFD Web solves the <b>steady incompressible Reynolds-averaged Navier–Stokes equations</b> with the <b>k-ω SST</b> turbulence model on a Cartesian grid, using WebGPU compute shaders on your graphics card. It runs entirely in the browser: the page is static files, there is no server, and your geometry never leaves the computer.
      </p>
      <ul className="guide">
        <li>The car is cut out of a stretched Cartesian grid (finest around the car and near wake). Cells crossed by the surface keep their open fraction, so sloped and curved panels are seen as smooth walls; very small cut cells are merged with a neighbour. Parts thinner than about two cells (wings, splitters) are modelled as zero-thickness walls.</li>
        <li>Walls use log-law wall functions, as in the OpenFOAM app. Separation on smooth bodies is still sensitive to resolution, and lift more so than drag.</li>
        <li>The flow is marched to a steady state with local time steps and a multigrid pressure solver. Forces are averaged over the last 30 % of the run.</li>
        <li>Boundary conditions follow the OpenFOAM version of EasyCFD: fixed-velocity inlet, fixed-pressure outlet, free-stream sides, symmetric top, moving road, rotating wheels and wall functions.</li>
        <li>Everything drawn comes from the solver: colours, smoke, streamlines and numbers are interpolated from computed cells. Points without nearby fluid show as grey.</li>
      </ul>
      <p>
        Results are meant for <b>design exploration</b>: comparing shapes and spotting trends. They are not a substitute for a validated CFD study or a wind tunnel. The solver was checked against the OpenFOAM app on several cars; the numbers, including any model that misses the target, are in{" "}
        <a href="./VALIDATION.md" target="_blank" rel="noreferrer">VALIDATION.md</a>.
      </p>
    </div>
  );
}

export function Help() {
  const help = useStore(app, (s) => s.help);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (help && !dialog.current?.open) dialog.current?.showModal();
  }, [help]);
  if (!help) return null;
  return (
    <dialog ref={dialog} className="help glass" onClose={() => app.set({ help: null })} aria-label="Help">
      <div className="help-head">
        <div className="segmented md" role="tablist">
          <button role="tab" aria-selected={help === "guide"} className={help === "guide" ? "on" : ""} onClick={() => app.set({ help: "guide" })}>Guide</button>
          <button role="tab" aria-selected={help === "solver"} className={help === "solver" ? "on" : ""} onClick={() => app.set({ help: "solver" })}>About the solver</button>
        </div>
        <button className="icon-btn" aria-label="Close help" onClick={() => dialog.current?.close()}><X size={18} /></button>
      </div>
      {help === "guide" ? <Guide /> : <Solver />}
    </dialog>
  );
}
