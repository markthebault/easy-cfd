// Step 3: mesh quality and the Run button.

import { useMemo } from "react";
import { Cpu, Play, Server, TriangleAlert, Zap } from "lucide-react";
import type { ServerInfo } from "../engine/openfoam";
import { partShapes } from "../solver/detail";
import { boundsOf } from "../solver/setup";
import { detailRatio, PRESETS, type Quality, type Settings } from "../solver/types";
import { useStore } from "../store/store";
import { app, setSettings } from "../store/app";
import { estimate } from "../store/estimate";
import { toSolverParts } from "../store/geometry";
import { startRun } from "../store/runs";
import { Slider } from "./controls";
import { boundaryLine, fmt, fmtCells, fmtDuration } from "./format";

const QUALITIES: { q: Quality; label: string; blurb: string }[] = [
  { q: "fast", label: "Fast", blurb: "Check the setup" },
  { q: "medium", label: "Medium", blurb: "Compare designs" },
  { q: "precise", label: "Precise", blurb: "Final numbers" },
  { q: "custom", label: "Custom", blurb: "Your own mesh" },
];

function detailWhere(zones: number, boxes: number, first: string): string {
  const parts = zones - boxes;
  const p = parts === 1 && !boxes ? `around ${first}` : parts ? `around ${parts} part${parts > 1 ? "s" : ""}` : "";
  const b = boxes ? `in ${boxes} detail box${boxes > 1 ? "es" : ""}` : "";
  return [p, b].filter(Boolean).join(" and ");
}

export function RunStep() {
  const design = useStore(app, (s) => s.design)!;
  const report = useStore(app, (s) => s.report);
  const gpu = useStore(app, (s) => s.gpu);
  const server = useStore(app, (s) => s.server);
  const confirmed = useStore(app, (s) => s.confirmed);
  const parts = useStore(app, (s) => s.parts);
  const groups = useStore(app, (s) => s.groups);
  const s = design.settings;
  // The grid is shaped by every part whose own switch is on (also those in groups switched off).
  const { shapes, low, high } = useMemo(() => {
    const solver = toSolverParts(parts, groups);
    return solver.length ? { shapes: partShapes(solver), ...boundsOf(solver) } : { shapes: [], low: [0, 0, 0] as const, high: [1, 1, 1] as const };
  }, [parts, groups]);
  const est = (settings: Settings) => estimate([...low], [...high], settings, shapes);
  const current = est(s);
  const blocked = !report || report.errors.length > 0 || !confirmed;
  const noGpu = gpu.status === "unavailable" || gpu.status === "checking";
  const openfoam = s.engine === "openfoam";
  const serverReady = server.status === "ready";

  return (
    <div className="step-body">
      <div className="engine-grid" role="radiogroup" aria-label="Solver engine">
        <button role="radio" aria-checked={!openfoam} className={`engine-card ${!openfoam ? "on" : ""}`} onClick={() => setSettings({ engine: "webgpu" })} data-testid="engine-webgpu">
          <span className="q-label"><Zap size={15} /> WebGPU</span>
          <span className="q-blurb">On this device · seconds to minutes</span>
          <span className="q-meta">Explore and compare designs</span>
        </button>
        <button
          role="radio"
          aria-checked={openfoam}
          className={`engine-card ${openfoam ? "on" : ""}`}
          disabled={server.status === "unavailable" || server.status === "checking"}
          onClick={() => setSettings({ engine: "openfoam", quality: s.quality === "custom" ? "medium" : s.quality })}
          data-testid="engine-openfoam"
        >
          <span className="q-label"><Server size={15} /> OpenFOAM <span className="badge ok">final check</span></span>
          <span className="q-blurb">On the EasyCFD server · minutes to an hour</span>
          <span className="q-meta">
            {server.status === "checking" ? "Looking for the server…" : server.status === "unavailable" ? "Not connected: open EasyCFD with just run-openfoam" : "Snapped mesh with prism layers, simpleFoam"}
          </span>
        </button>
      </div>

      {openfoam ? <OpenFoamQualities quality={s.quality} info={server.info} /> : (
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
      )}

      {!openfoam && s.quality === "custom" && (
        <div className="group">
          <Slider label="Cells along the car length" min={40} max={220} step={1} value={s.custom_cells} onChange={(v) => setSettings({ custom_cells: v })} />
          <Slider label="Flow passes" min={2} max={40} step={1} value={s.custom_passes} display={`${s.custom_passes} × car length`} onChange={(v) => setSettings({ custom_passes: v })} />
          <small className="field-hint">More passes let the wake settle; forces are averaged over the last 30 %.</small>
        </div>
      )}

      {!openfoam && (
        <div className="group">
          <Slider
            label="Detail cells around aero parts"
            min={1}
            max={4}
            step={0.5}
            value={detailRatio(s)}
            display={detailRatio(s) <= 1 ? "off" : `${detailRatio(s)}× finer`}
            onChange={(v) => setSettings({ detail_ratio: v })}
          />
          <small className="field-hint">
            Experimental, off by default. Finer cells around thin or small parts and in detail boxes; 3–6× slower. On some cars they change the body flow or make the run unstable, and wing downforce stays under-predicted. See the validation notes.
          </small>
        </div>
      )}

      {!openfoam && current && current.detail.zones.length > 0 && (
        <p className="detail-line small" data-testid="detail-line">
          Detail cells {current.detail.ratio}× finer {detailWhere(current.detail.zones.length, s.detail_boxes?.length ?? 0, current.detail.zones[0])}
          {current.detail.ratio < current.detail.requested ? ` (limited from ${current.detail.requested}× by the cell budget)` : ""}.
          <span className="muted"> Set per group in the car step.</span>
        </p>
      )}

      {openfoam ? <OpenFoamSummary quality={s.quality} info={server.info} /> : (
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
      )}

      {openfoam ? (
        <div className={`gpu-line ${serverReady ? "ready" : "unavailable"}`}>
          {serverReady ? <><Server size={15} /> <span>OpenFOAM server · {server.info?.cpus ?? "?"} CPUs · {fmt(server.info?.memory_gb ?? 0, 1)} GB memory</span></> : <><TriangleAlert size={15} /> <span>{server.info?.message || "The OpenFOAM server is not ready."}</span></>}
        </div>
      ) : (
        <div className={`gpu-line ${gpu.status}`}>
          {gpu.status === "ready" && <><Cpu size={15} /> <span>WebGPU · {gpu.adapter || "GPU ready"}</span></>}
          {gpu.status === "checking" && <><Cpu size={15} /> <span>Checking WebGPU…</span></>}
          {(gpu.status === "software" || gpu.status === "unavailable") && <><TriangleAlert size={15} /> <span>{gpu.message}</span></>}
        </div>
      )}

      <button className="btn run block" disabled={blocked || (openfoam ? !serverReady : noGpu)} onClick={() => startRun()} data-testid="run">
        <Play size={20} fill="currentColor" /> {openfoam ? "Run on OpenFOAM" : "Run simulation"}
      </button>
      <p className="small center" data-testid="run-boundaries">{boundaryLine(s)}</p>
      {blocked && <small className="field-hint center">Finish the car step and tick the check box first.</small>}
      {openfoam && !blocked && <small className="field-hint center">The run continues on the server if you close this tab; open it later from the run list.</small>}
    </div>
  );
}

const OF_QUALITIES: { q: "fast" | "medium" | "precise"; label: string }[] = [
  { q: "fast", label: "Fast" },
  { q: "medium", label: "Medium" },
  { q: "precise", label: "Precise" },
];

function measuredText(info: ServerInfo | null, q: "fast" | "medium" | "precise"): string {
  const m = info?.measured[q];
  return m ? `~${fmtDuration(m.seconds)} (median of ${m.runs} run${m.runs > 1 ? "s" : ""} here)` : "no runs measured here yet";
}

function OpenFoamQualities({ quality, info }: { quality: string; info: ServerInfo | null }) {
  return (
    <div className="quality-grid of" role="radiogroup" aria-label="OpenFOAM quality">
      {OF_QUALITIES.map(({ q, label }) => {
        const p = info?.presets[q];
        const on = quality === q || (q === "medium" && quality === "custom");
        return (
          <button key={q} role="radio" aria-checked={on} className={`quality-card ${on ? "on" : ""}`} onClick={() => setSettings({ quality: q })}>
            <span className="q-label">{label}</span>
            <span className="q-blurb">{p?.label ?? ""}</span>
            <span className="q-meta">{p ? `≤ ${fmtCells(p.max_cells)} cells · ${p.layers ? `${p.layers} layers · ` : ""}${p.iterations} iterations` : "–"}</span>
            <span className="q-est">{measuredText(info, q)}</span>
          </button>
        );
      })}
    </div>
  );
}

function OpenFoamSummary({ quality, info }: { quality: string; info: ServerInfo | null }) {
  const q = (quality === "custom" ? "medium" : quality) as "fast" | "medium" | "precise";
  const p = info?.presets[q];
  const m = info?.measured[q];
  return (
    <div className="run-summary">
      <div>
        <span className="run-big">{p ? `≤ ${fmtCells(p.max_cells)}` : "–"}</span>
        <span className="run-small">cells, snappyHexMesh{p?.layers ? ` with ${p.layers} prism layers` : ""}</span>
      </div>
      <div>
        <span className="run-big">{m ? `~${fmtDuration(m.seconds)}` : "–"}</span>
        <span className="run-small">{m ? `median of ${m.runs} run${m.runs > 1 ? "s" : ""} on this server` : "runtime depends on the car; the first run measures it"}</span>
      </div>
    </div>
  );
}
