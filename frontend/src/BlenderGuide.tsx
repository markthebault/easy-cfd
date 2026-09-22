import { useEffect, useRef } from "react";
import { X } from "lucide-react";

const manual = "https://docs.blender.org/manual/en/5.2/";
export default function BlenderGuide({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="blender-guide"
      aria-labelledby="blender-guide-title"
      onClose={close}
    >
      <div className="guide-heading">
        <div>
          <span className="eyebrow">MODEL PREPARATION</span>
          <h2 id="blender-guide-title">Blender → Easy CFD</h2>
        </div>
        <button
          autoFocus
          className="secondary"
          aria-label="Close Blender guide"
          onClick={() => dialog.current?.close()}
        >
          <X size={18} /> Close
        </button>
      </div>
      <p className="guide-version">
        For Blender 5.2.2 LTS · Checked 22 September 2026 against the official
        manual.
      </p>
      <p>
        Start with a copy of your Blender file. Prepare the complete car with
        each wheel separate. This guide is for external airflow with a closed
        cabin.
      </p>
      <ol className="guide-steps">
        <li>
          <h3>Set the real size and orientation</h3>
          <p>
            In <strong>Scene Properties → Units</strong>, choose{" "}
            <strong>Metric</strong>, <strong>Unit Scale 1.0</strong>, and{" "}
            <strong>Length: Meters</strong>. Check dimensions in the viewport
            sidebar, <strong>Item → Dimensions</strong>. A full-size car should
            be roughly 4 metres long, not 400 metres.
          </p>
          <p>
            Changing units does not resize the mesh. If needed, select the
            entire car assembly and scale it together around a shared pivot.
            Point the nose toward <strong>−Y</strong>, with{" "}
            <strong>+Z up</strong>. In Object Mode, use{" "}
            <strong>Object → Apply → Rotation &amp; Scale</strong>.
          </p>
        </li>
        <li>
          <h3>Keep the four wheels separate</h3>
          <p>
            Use one body object and four wheel objects, named <code>body</code>,{" "}
            <code>wheel_front_left</code>, <code>wheel_front_right</code>,{" "}
            <code>wheel_rear_left</code>, and <code>wheel_rear_right</code>. A
            wing or splitter can be another closed part.
          </p>
          <p>
            If a wheel is part of the body mesh, enter Edit Mode, select all of
            that wheel's geometry, then{" "}
            <strong>Mesh → Separate → Selection</strong>, or <kbd>P</kbd> →
            Selection. <strong>By Loose Parts</strong> separates every
            disconnected piece and can create hundreds of objects; use it only
            when appropriate.
          </p>
          <p>
            Keep every part in its assembled position. Do not move each wheel to
            the origin. Wheel axles should run across the car, along X in this
            Blender setup. Steered or cambered wheels are outside this app's
            wheel model.
          </p>
        </li>
        <li>
          <h3>Make closed exterior solids</h3>
          <p>
            Remove seats, engine internals, brake detail, badges, and hidden
            duplicate faces that are unnecessary for the test. Keep the roof,
            windows, mirrors, wheel arches, and a deliberate underbody shape.
            Seal the cabin and any openings whose internal airflow you are not
            modelling.
          </p>
          <p>
            Each exported part must enclose a volume. A thin wing needs
            thickness and closed edges. For an initial test, use closed tire
            envelopes with covered wheel faces. Avoid intersecting parts and
            wheel-to-body contact. Joining objects alone does not weld them or
            make a solid.
          </p>
          <p className="guide-caution">
            <strong>Smooth shading does not repair geometry.</strong> Coarse
            voxel remeshing changes bodywork and can create ridges. Inspect the
            actual surface and preserve important curves and gaps.
          </p>
        </li>
        <li>
          <h3>Check holes and face direction</h3>
          <p>
            For each mesh, enter Edit Mode and use vertex or edge selection.
            Deselect everything, then{" "}
            <strong>Select → Select All by Trait → Non Manifold</strong>, with
            boundary detection enabled. Repair highlighted open edges or invalid
            connections before export.
          </p>
          <p>
            Select all faces and use{" "}
            <strong>Mesh → Normals → Recalculate Outside</strong>. Inspect{" "}
            <strong>Face Orientation</strong> in Viewport Overlays. Recheck
            after modifiers: a clean selection alone does not rule out
            overlapping or self-intersecting surfaces.
          </p>
        </li>
        <li>
          <h3>Export one STL per object</h3>
          <p>
            Select only the prepared car parts. Use{" "}
            <strong>File → Export → STL (.stl)</strong> with these settings:
          </p>
          <div className="guide-table-wrap">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Selection Only</th>
                  <td>On</td>
                </tr>
                <tr>
                  <th scope="row">Batch</th>
                  <td>On, one STL for each object</td>
                </tr>
                <tr>
                  <th scope="row">ASCII</th>
                  <td>Off, for smaller binary files</td>
                </tr>
                <tr>
                  <th scope="row">Scale / Scene Unit</th>
                  <td>1.0 / On, with Scene Unit Scale 1.0</td>
                </tr>
                <tr>
                  <th scope="row">Forward / Up</th>
                  <td>Y / Z, preserving this Blender coordinate setup</td>
                </tr>
                <tr>
                  <th scope="row">Apply Modifiers</th>
                  <td>
                    On; choose Viewport if that is the geometry you checked
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            The export's <strong>Forward Y</strong> is an axis-conversion
            setting. Your car's nose still points toward <strong>−Y</strong> in
            the exported files. Keep identical settings for every part.
          </p>
        </li>
        <li>
          <h3>Import and verify in Easy CFD</h3>
          <p>
            Choose <strong>Import STEP / STL</strong> and select all exported
            files together. Set <strong>STL units: Metres</strong>,{" "}
            <strong>Nose points toward: −Y</strong>, and{" "}
            <strong>Up direction: +Z</strong>. Start with a{" "}
            <strong>0.01 m</strong> lowest-point gap above the road; review the
            resulting ride height. Do not export a road plane.
          </p>
          <p>
            Check dimensions and rotate the model. Set each tire's role to{" "}
            <strong>Wheel</strong> and verify its radius in metres. The app uses
            each part's bounding-box centre as its initial wheel centre. Confirm
            the checklist only after checking size, orientation, wheel roles,
            and clearance.
          </p>
          <p>
            Run <strong>Fast</strong> to check the setup, then{" "}
            <strong>Medium</strong> for a better mesh. Review mesh, convergence,
            and near-wall warnings before comparing forces. A successful export
            does not establish aerodynamic accuracy.
          </p>
        </li>
      </ol>
      <details className="guide-troubleshooting">
        <summary>Common problems</summary>
        <ul>
          <li>
            <strong>Wrong size:</strong> check Blender dimensions, scene scale,
            export scale, and import units. STL does not reliably store units.
          </li>
          <li>
            <strong>Too many parts:</strong> remove loose trim and repair the
            intended solids. Easy CFD splits disconnected STL shells even when
            Blender groups them in one object.
          </li>
          <li>
            <strong>Open-surface error:</strong> repair the mesh in Blender.
            Shading, materials, and simply joining objects cannot close it.
          </li>
          <li>
            <strong>Wheels in the wrong place:</strong> preserve shared assembly
            coordinates and import all files at once.
          </li>
        </ul>
        <p>
          Import limits: 20 files, 100 MB combined, 100 connected parts, and 1.5
          million triangles.
        </p>
      </details>
      <p className="guide-sources">
        Official references:{" "}
        <a
          href="https://www.blender.org/releases/5-2/"
          target="_blank"
          rel="noreferrer"
        >
          5.2 LTS release
        </a>{" "}
        ·{" "}
        <a
          href={manual + "files/import_export/stl.html"}
          target="_blank"
          rel="noreferrer"
        >
          STL export
        </a>{" "}
        ·{" "}
        <a
          href={manual + "modeling/meshes/editing/mesh/separate.html"}
          target="_blank"
          rel="noreferrer"
        >
          Separate
        </a>{" "}
        ·{" "}
        <a
          href={manual + "scene_layout/object/editing/apply.html"}
          target="_blank"
          rel="noreferrer"
        >
          Apply transforms
        </a>{" "}
        ·{" "}
        <a
          href={manual + "modeling/meshes/selecting/all_by_trait.html"}
          target="_blank"
          rel="noreferrer"
        >
          Non Manifold
        </a>{" "}
        ·{" "}
        <a
          href={manual + "modeling/meshes/editing/mesh/normals.html"}
          target="_blank"
          rel="noreferrer"
        >
          Normals
        </a>
        .
      </p>
    </dialog>
  );
}
