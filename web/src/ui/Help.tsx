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
        <li><b>Explore airflow</b> sets up a view and its camera. Vertical streamlines follow air over and under the car; horizontal streamlines follow air around its sides. Settings let you move the seed rake and change the number of lines.</li>
        <li><b>3D pressure clouds</b> mark equal static pressure in the air. Blue is suction and coral is positive pressure. Lower the threshold to reveal weaker regions. Surface flow shows near-wall direction, not friction stress; turbulent energy is not an acoustic noise level.</li>
        <li><b>Force arrows</b> show the saved average forces in newtons with a shared length scale. Their position is illustrative, not a measured centre of pressure.</li>
        <li><b>Downforce</b> (kg) pushes the car onto the road; negative Cl means downforce. <b>Lift</b> is the opposite.</li>
        <li>Use browser <b>Quick</b> to check the setup and <b>Fast</b> for a finer light mesh. Connect an OpenFOAM server for advanced analysis. Compare runs with the same speed, reference area and quality.</li>
        <li>A <b>Provisional</b> badge means forces were still moving at the end: run longer (more passes) before trusting small differences.</li>
        <li>The <b>Slice</b> in Cp0 and the <b>Wake</b> surface show where the air loses energy. A smaller wake usually means less drag.</li>
      </ul>
      <h3>Controls</h3>
      <ul className="guide">
        <li>The <b>Driving preview</b> shows five soft smoke streams bending over the body and around its sides, a moving road and tyre rotation. The smoke is a lightweight illustration of the shape and crosswind. Run a simulation for computed airflow. Road and wheels follow your Conditions settings; playback is slowed for viewing.</li>
        <li><b>Place wheels on ground</b> positions the car at road level with the 5 mm clearance needed for a run. <b>Lift car</b> raises it to 150 mm; enter a height for other positions, including 0 mm for exact contact in the preview. The body and all added parts move together.</li>
        <li><b>Expand view</b> hides the setup or results panel. Pause freezes smoke, road, tyres and computed flow together. Road &amp; tyres and Smoke switches control what is drawn; they do not change a saved run.</li>
        <li>Drag to orbit, right-drag or two-finger drag to pan, scroll to zoom. Orbit below the road or choose <b>Underbody</b> to inspect the floor and diffuser. The road fades out below the car. Click a face of the orientation cube to snap the camera.</li>
        <li>Coloured knobs in the view move the smoke rake, the streamline rake and the slice.</li>
      </ul>
    </div>
  );
}

function Solver() {
  return (
    <div className="help-body">
      <p>
        EasyCFD solves the <b>steady incompressible Reynolds-averaged Navier–Stokes equations</b> with OpenFOAM's <b>k-ω SST</b> turbulence model. Browser runs mesh and solve locally using WebAssembly. Server runs upload the model to the OpenFOAM backend you connect.
      </p>
      <ul className="guide">
        <li>OpenFOAM's snappyHexMesh refines and snaps the mesh to the enabled car surfaces. Quick uses a coarse mesh without prism layers; Fast adds finer surface cells and requests one prism layer. Thin parts and small gaps can require the server's larger mesh budget.</li>
        <li>Enabled groups and parts are simulated. Results retain per-part and per-group pressure and friction forces. Different designs can create different meshes, so use server refinement studies to assess grid sensitivity.</li>
        <li>Walls use log-law wall functions, as in the OpenFOAM app. Separation on smooth bodies is still sensitive to resolution, and lift more so than drag.</li>
        <li>The steady SIMPLE solver uses double precision. Forces and moments are averaged over the last 50 iterations. Force settling and residual convergence are reported separately.</li>
        <li>Browser OpenFOAM needs no solver server and keeps the geometry on this device. Keep the tab open while it runs. For advanced meshes and physical-time recordings, connect a token-protected backend URL in Run. Both engines use the same result views and browser library.</li>
        <li>Boundary conditions follow the OpenFOAM version of EasyCFD: fixed-velocity inlet, fixed-pressure outlet, free-stream sides, symmetric top, moving road, rotating wheels and wall functions.</li>
        <li>Everything drawn comes from the solver: colours, smoke, streamlines and numbers are interpolated from computed cells. Points without nearby fluid show as grey.</li>
      </ul>
      <p>
        Results are meant for <b>design exploration</b>: comparing shapes and spotting trends. Light browser meshes do not establish physical aerodynamic accuracy. Browser tests and their limits are recorded in{" "}
        <a href="./VALIDATION.md" target="_blank" rel="noreferrer">VALIDATION.md</a>.
      </p>
      <p><a href="./openfoam/source.html" target="_blank" rel="noreferrer">OpenFOAM source and GPL license</a></p>
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
