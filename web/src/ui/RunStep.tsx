// Step 3: mesh quality and the Run button.

import { Cpu, Play, TriangleAlert } from "lucide-react";
import { PRESETS, type Quality, type Settings, type Vec3 } from "../solver/types";
import { useStore } from "../store/store";
import { app, setSettings } from "../store/app";
import { estimate } from "../store/estimate";
import { startRun } from "../store/runs";
import { Slider } from "./controls";
import { fmtCells, fmtDuration } from "./format";

const QUALITIES: { q: Quality; label: string; blurb: string }[] = [
  { q: "fast", label: "Fast", blurb: "Check the setup" },
  { q: "medium", label: "Medium", blurb: "Compare designs" },
  { q: "precise", label: "Precise", blurb: "Final numbers" },
  { q: "custom", label: "Custom", blurb: "Your own mesh" },
];

export function RunStep() {
  const design = useStore(app, (s) => s.design)!;
  const report = useStore(app, (s) => s.report);
  const gpu = useStore(app, (s) => s.gpu);
  const confirmed = useStore(app, (s) => s.confirmed);
  const s = design.settings;
  const low = (report?.low ?? [0, 0, 0]) as Vec3;
  const high = (report?.high ?? [1, 1, 1]) as Vec3;
  const est = (settings: Settings) => estimate(low, high, settings);
  const current = est(s);
  const blocked = !report || report.errors.length > 0 || !confirmed;
  const noGpu = gpu.status === "unavailable" || gpu.status === "checking";

  return (
    <div className="step-body">
      <div className="quality-grid" role="radiogroup" aria-label="Quality">
        {QUALITIES.map(({ q, label, blurb }) => {
          const e = est({ ...s, quality: q });
          const on = s.quality === q;
          const p = q === "custom" ? { cellsPerLength: s.custom_cells, passes: s.custom_passes } : PRESETS[q];
          return (
            <button key={q} role="radio" aria-checked={on} className={`quality-card ${on ? "on" : ""}`} onClick={() => setSettings({ quality: q })}>
              <span className="q-label">{label}</span>
              <span className="q-blurb">{blurb}</span>
              <span className="q-meta">{p.cellsPerLength} cells/length · {p.passes} passes</span>
              <span className="q-est">{e ? `${fmtCells(e.cells)} cells · ~${fmtDuration(e.seconds)}` : "–"}</span>
            </button>
          );
        })}
      </div>

      {s.quality === "custom" && (
        <div className="group">
          <Slider label="Cells along the car length" min={40} max={220} step={1} value={s.custom_cells} onChange={(v) => setSettings({ custom_cells: v })} />
          <Slider label="Flow passes" min={2} max={40} step={1} value={s.custom_passes} display={`${s.custom_passes} × car length`} onChange={(v) => setSettings({ custom_passes: v })} />
          <small className="field-hint">More passes let the wake settle; forces are averaged over the last 30 %.</small>
        </div>
      )}

      <div className="run-summary">
        <div>
          <span className="run-big">{current ? fmtCells(current.cells) : "–"}</span>
          <span className="run-small">cells{current ? ` · ${current.grid.join(" × ")}` : ""}</span>
        </div>
        <div>
          <span className="run-big">~{current ? fmtDuration(current.seconds) : "–"}</span>
          <span className="run-small">{current?.calibrated ? "estimate from your last runs" : "rough estimate, improves after a run"}</span>
        </div>
      </div>

      <div className={`gpu-line ${gpu.status}`}>
        {gpu.status === "ready" && <><Cpu size={15} /> <span>WebGPU · {gpu.adapter || "GPU ready"}</span></>}
        {gpu.status === "checking" && <><Cpu size={15} /> <span>Checking WebGPU…</span></>}
        {(gpu.status === "software" || gpu.status === "unavailable") && <><TriangleAlert size={15} /> <span>{gpu.message}</span></>}
      </div>

      <button className="btn run block" disabled={blocked || noGpu} onClick={() => startRun()} data-testid="run">
        <Play size={20} fill="currentColor" /> Run simulation
      </button>
      {blocked && <small className="field-hint center">Finish the car step and tick the check box first.</small>}
    </div>
  );
}
