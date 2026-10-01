// Step 1: the car. Source files, units and axes, clearance, parts and roles, geometry checks.

import { useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, CircleAlert, FlipVertical2, Lightbulb, Plus, RotateCw, Upload, X } from "lucide-react";
import type { AxisName, Units } from "../geometry/model";
import { useStore } from "../store/store";
import {
  app, applyHint, goStep, importFiles, loadSample, removeFile, setConfirmed, setImport, setRoadHeight,
} from "../store/app";
import { ROAD_CONTACT_ERROR, roadPosition } from "../geometry/roadPosition";
import { fixAxes, flipUpsideDown, swapNoseTail, turn90 } from "../store/geometry";
import { Field, NumberField, Segmented, Toggle } from "./controls";
import { GroupsPanel } from "./GroupsPanel";
import { fmt, fmtInt } from "./format";

const AXES: AxisName[] = ["-X", "+X", "-Y", "+Y", "-Z", "+Z"];

/** The remaining axis perpendicular to both the nose and the current up direction. */
const nextUp = (forward: AxisName, up: AxisName): AxisName =>
  (["+Z", "+Y", "+X"] as AxisName[]).find((a) => a[1] !== forward[1] && a[1] !== up[1])!;

export function CarStep() {
  const design = useStore(app, (s) => s.design)!;
  const report = useStore(app, (s) => s.report);
  const confirmed = useStore(app, (s) => s.confirmed);
  const parts = useStore(app, (s) => s.parts);
  const busy = useStore(app, (s) => s.busy);
  const addInput = useRef<HTMLInputElement>(null);
  const [allFiles, setAllFiles] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const o = design.importOptions;
  const sample = design.source.kind === "sample";
  const dims = report?.dimensions ?? [0, 0, 0];
  const canContinue = !!report && report.errors.length === 0 && confirmed;
  const position = roadPosition(parts);
  const height = position.height ?? 0;
  const geometryErrors = report?.errors.filter(e => e !== ROAD_CONTACT_ERROR) ?? [];
  const needsGap = report?.errors.includes(ROAD_CONTACT_ERROR) ?? false;

  return (
    <div className="step-body">
      <div className="source-row">
        {sample ? (
          <div className="source-sample">
            <span className="source-name">Built-in sample car</span>
            <Toggle
              checked={design.source.kind === "sample" && design.source.wing}
              onChange={(w) => loadSample(w)}
              label="Rear wing"
            />
          </div>
        ) : (
          <ul className="file-chips">
            {design.source.kind === "files" &&
              (allFiles ? design.source.files : design.source.files.slice(0, 4)).map((f) => (
                <li key={f.hash + f.name} title={f.base ? "Defines the car's position" : "Added part, keeps its exported position"}>
                  <span className="file-name">{f.name}</span>
                  {!f.base && <span className="file-tag">added</span>}
                  <button className="icon-btn xs" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.hash)}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            {design.source.kind === "files" && design.source.files.length > 4 && (
              <li className="more">
                <button className="link" onClick={() => setAllFiles(!allFiles)}>
                  {allFiles ? "Show fewer" : `+${design.source.files.length - 4} more`}
                </button>
              </li>
            )}
          </ul>
        )}
        <div className="row gap-s">
          {!sample && (
            <button className="btn ghost sm" onClick={() => addInput.current?.click()} title="Add wings, splitters or wheels exported in the same coordinates">
              <Plus size={15} /> Add parts
            </button>
          )}
          <button className="btn ghost sm" onClick={() => replaceInput.current?.click()}>
            <Upload size={15} /> {sample ? "Use my car" : "Replace"}
          </button>
        </div>
        <input ref={addInput} type="file" hidden multiple accept=".stl,.obj,.glb,.gltf" onChange={(e) => { importFiles([...(e.target.files ?? [])], true); e.target.value = ""; }} />
        <input ref={replaceInput} type="file" hidden multiple accept=".stl,.obj,.glb,.gltf" onChange={(e) => { importFiles([...(e.target.files ?? [])], false); e.target.value = ""; }} />
      </div>

      <div className="dims" aria-label="Car dimensions">
        {(["Length", "Width", "Height"] as const).map((label, i) => (
          <div key={label} className="dim">
            <span className="dim-value">{fmt(dims[i], 2)}<small> m</small></span>
            <span className="dim-label">{label}</span>
          </div>
        ))}
      </div>
      <div className="dims-meta">
        <span>{fmtInt(report?.triangles ?? 0)} triangles</span>
        <span>Frontal area {fmt(report?.frontalArea ?? 0, 2)} m²</span>
      </div>

      {report && (geometryErrors.length > 0 || report.warnings.length > 0 || report.hints.length > 0) && (
        <ul className="issues">
          {geometryErrors.map((e) => (
            <li key={e} className="issue error"><CircleAlert size={15} /> <span>{e}</span></li>
          ))}
          {report.hints.map((h) => (
            <li key={h.label} className="issue hint">
              <Lightbulb size={15} /> <span>{h.label}</span>
              {(h.apply.units || h.apply.turn) && <button className="btn tiny" onClick={() => applyHint(h.apply)}>Fix</button>}
              {!h.apply.units && !h.apply.turn && <button className="btn tiny" onClick={() => setImport({ up: nextUp(o.forward, o.up) })}>Try other up</button>}
            </li>
          ))}
          {report.warnings.map((w) => (
            <li key={w} className="issue warn"><AlertTriangle size={15} /> <span>{w}</span></li>
          ))}
        </ul>
      )}

      <div className="group">
        <div className="group-title">Size and orientation</div>
        <Field label="File units">
          <Segmented<Units>
            label="File units"
            size="sm"
            value={o.units}
            options={[{ value: "m", label: "m" }, { value: "mm", label: "mm" }, { value: "cm", label: "cm" }, { value: "in", label: "in" }]}
            onChange={(units) => setImport({ units })}
          />
        </Field>
        <div className="row gap-m">
          <Field label="Nose points to">
            <select value={o.forward} onChange={(e) => setImport(fixAxes({ ...o, forward: e.target.value as AxisName }, "forward"))} aria-label="Nose direction in the file">
              {AXES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Up is">
            <select value={o.up} onChange={(e) => setImport(fixAxes({ ...o, up: e.target.value as AxisName }, "up"))} aria-label="Up direction in the file">
              {AXES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        </div>
        <div className="quick-row">
          <button className="btn ghost sm" onClick={() => setImport(turn90(o))}><RotateCw size={15} /> Turn 90°</button>
          <button className="btn ghost sm" onClick={() => setImport(swapNoseTail(o))}><ArrowLeftRight size={15} /> Nose ↔ tail</button>
          <button className="btn ghost sm" onClick={() => setImport(flipUpsideDown(o))}><FlipVertical2 size={15} /> Flip</button>
        </div>
      </div>

      <div className="group road-position">
        <div className="road-position-heading"><div className="group-title">Position above road</div><span className={`height-status ${height >= -1e-6 && height <= 0.005 + 1e-6 ? "grounded" : ""}`}>{height < -1e-6 ? "Below road" : height < 1e-6 ? "Exact contact" : height <= 0.005 + 1e-6 ? "On ground" : "Raised"}</span></div>
        <p className="muted small">{position.wheels ? "Height is measured under the lowest enabled wheel. Every part moves together." : "No wheels marked. Height is measured under the model’s lowest enabled part."}</p>
        <div className="height-actions">
          <button className="btn ghost sm" disabled={!!busy || position.height === null} onClick={() => setRoadHeight(0.005, true)} title="Place the car at road level with the 5 mm gap required for simulation"><ArrowDownToLine size={15} />{position.wheels ? "Place wheels on ground" : "Place model on ground"}</button>
          <button className="btn ghost sm" disabled={!!busy || position.height === null} onClick={() => setRoadHeight(0.15)}><ArrowUpFromLine size={15} />Lift car</button>
        </div>
        {needsGap && <div className="road-contact-note" role="status">Ground contact is set. Before running, use <b>Simulation gap</b> below to leave the required 5 mm clearance.</div>}
        <Field label="Height above road" hint="Ground placement leaves a 5 mm simulation gap. Enter 0 mm for exact contact in the preview.">
          <div className="row gap-s">
            <NumberField value={+(height * 1000).toFixed(1)} min={0} max={2000} step={1} unit="mm" label="Height above road" onChange={(v) => setRoadHeight(v / 1000)} width={110} />
            <button className="btn ghost sm" disabled={!!busy || position.height === null} onClick={() => setRoadHeight(0.005, true)}>Simulation gap <span className="muted">5 mm</span></button>
          </div>
        </Field>
      </div>

      <GroupsPanel />
      <small className="field-hint">Wheels spin at road speed about their centre when "Rotating wheels" is on.</small>

      <label className={`confirm ${confirmed ? "on" : ""}`}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I checked size, orientation, wheels and clearance.</span>
      </label>
      <button className="btn primary block" disabled={!canContinue} onClick={() => goStep("conditions")}>
        Continue to conditions
      </button>
    </div>
  );
}
