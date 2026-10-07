// First screen: drop zone, sample car and recent work.

import { useRef, useState } from "react";
import { Car, Clock, FileUp, TriangleAlert } from "lucide-react";
import { useStore } from "../store/store";
import { app, importFiles, loadSample, openDesign } from "../store/app";
import { openRun } from "../store/runs";
import { Toggle } from "./controls";
import { fmtDate, verticalLoad } from "./format";

export function EmptyState() {
  const input = useRef<HTMLInputElement>(null);
  const [wing, setWing] = useState(false);
  const [over, setOver] = useState(false);
  const designs = useStore(app, (s) => s.designs);
  const runs = useStore(app, (s) => s.runs);
  const gpu = useStore(app, (s) => s.gpu);
  return (
    <div className="empty">
      <div className="empty-card glass">
        <h1>Virtual wind tunnel</h1>
        <p className="lead">Drop in a car, pick a speed, and watch the air flow around it. The flow is solved on your GPU, inside this page; files never leave your computer.</p>
        <div
          className={`dropzone ${over ? "over" : ""}`}
          data-drop="replace"
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            importFiles([...e.dataTransfer.files], false);
          }}
        >
          <FileUp size={30} />
          <b>Drop your car here</b>
          <span>STL, OBJ, GLB or glTF · several files for body and wheels</span>
          <span className="btn primary sm">Choose files</span>
          <input ref={input} type="file" hidden multiple accept=".stl,.obj,.glb,.gltf" onChange={(e) => { importFiles([...(e.target.files ?? [])], false); e.target.value = ""; }} />
        </div>
        <div className="or"><span>or</span></div>
        <div className="sample-row">
          <button className="btn secondary" onClick={() => loadSample(wing)} data-testid="try-sample">
            <Car size={18} /> Try the sample car
          </button>
          <Toggle checked={wing} onChange={setWing} label="with rear wing" />
        </div>
        <p className="course-entry"><a href={`${import.meta.env.BASE_URL}course/index.html`} target="_blank" rel="noopener">Learn car aerodynamics</a> · a four-day course with visual lessons and practical labs.</p>
        {(gpu.status === "unavailable" || gpu.status === "software") && (
          <p className={`gpu-note ${gpu.status}`}><TriangleAlert size={15} /> {gpu.message}</p>
        )}
        {(designs.length > 0 || runs.length > 0) && (
          <div className="recent">
            <div className="recent-title"><Clock size={14} /> Recent</div>
            <ul>
              {designs.slice(0, 3).map((d) => (
                <li key={d.id}><button onClick={() => openDesign(d.id)}><b>{d.name}</b><span>design · {fmtDate(d.updatedAt)}</span></button></li>
              ))}
              {runs.slice(0, 3).map((r) => {
                const v = verticalLoad(r.result);
                return (
                  <li key={r.id}>
                    <button onClick={() => openRun(r.id)}>
                      <b>{r.designName}</b>
                      <span>run · Cd {r.result.cd.toFixed(3)} · {v.label.toLowerCase()} {v.kg.toFixed(0)} kg · {fmtDate(r.createdAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
