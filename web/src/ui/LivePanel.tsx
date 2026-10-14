// Live solving view: progress, streaming force chart and the latest (provisional) coefficients.

import { useState } from "react";
import { CircleAlert, Square } from "lucide-react";
import { useStore } from "../store/store";
import { app } from "../store/app";
import { cancelRun, dismissLive } from "../store/runs";
import { ForceChart } from "./ForceChart";
import { StatsTable } from "./StatsTable";
import { ITERATIONS } from "./historyUnit";
import { trailingStats } from "./windowStats";
import { boundaryLine, conditionsLine, fmt, fmtCells, fmtDuration, fmtInt } from "./format";

/** The server's stage text without the quality prefix ("medium: Meshing car" → "Meshing car"). */
function serverStageText(stage: string | undefined): string {
  if (!stage) return "OpenFOAM";
  const [tier, rest] = stage.includes(": ") ? stage.split(": ", 2) : ["", stage];
  return tier && rest ? `${rest} (${tier})` : stage;
}

export function LivePanel() {
  const live = useStore(app, (s) => s.live);
  const [pick, setPick] = useState<number | null>(null);
  if (!live) return null;
  const last = live.history[live.history.length - 1];
  const unit = ITERATIONS;
  const win = pick ?? unit.choices[0];
  const avg = trailingStats(live.history, win);
  const remaining = live.fraction > 0.03 && live.stage === "solving" ? (live.elapsed / live.fraction) * (1 - live.fraction) : NaN;

  if (live.error)
    return (
      <div className="live">
        <div className="live-head">
          <span className="eyebrow error">Stopped</span>
          <h2>The simulation failed</h2>
        </div>
        <p className="issue error"><CircleAlert size={16} /> <span>{live.error}</span></p>
        <p className="muted small">Nothing was saved. Check for tiny gaps or intersecting parts, or try a finer mesh.</p>
        <button className="btn primary block" onClick={dismissLive}>Back to setup</button>
      </div>
    );

  return (
    <div className="live" aria-live="polite">
      <div className="live-head">
        <span className="eyebrow"><span className="rec" /> Live · OpenFOAM {live.runtime === "wasm" ? "browser" : "server"}</span>
        <h2>{serverStageText(live.serverStage)}</h2>
        <p className="muted small">{live.designName} · {conditionsLine(live.settings)}</p>
        <p className="muted small" data-testid="run-boundaries">{boundaryLine(live.settings)}</p>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(live.fraction * 100)}>
        <div className={`progress-fill ${live.stage === "preparing" ? "indeterminate" : ""}`} style={{ width: live.stage === "preparing" ? "30%" : `${live.fraction * 100}%` }} />
      </div>
      <div className="live-stats">
          <div><b>{fmtInt(live.iteration ?? 0)}<small> / {fmtInt(live.iterations ?? 0)}</small></b><span>iterations</span></div>
          {live.recordingDuration && <div><b>{fmt(live.recordingTime ?? 0,3)}<small> / {fmt(live.recordingDuration,3)} s</small></b><span>recording physical time</span></div>}
          <div><b>{fmtDuration(live.elapsed)}</b><span>elapsed{Number.isFinite(remaining) ? ` · ~${fmtDuration(remaining)} left` : ""}</span></div>
          <div><b>{live.cells ? fmtCells(live.cells) : "–"}</b><span>cells</span></div>
      </div>
      <div className="live-coeffs">
        <div title={last ? `Latest value ${last.cd.toFixed(4)}` : undefined}><span>Cd</span><b>{avg ? avg.cd.mean.toFixed(4) : last ? last.cd.toFixed(4) : "–"}</b></div>
        <div title={last ? `Latest value ${last.cl.toFixed(4)}` : undefined}><span>Cl</span><b>{avg ? avg.cl.mean.toFixed(4) : last ? last.cl.toFixed(4) : "–"}</b></div>
        <span className="badge warn" title={avg ? `Provisional: mean over the last ${win} ${win === 1 ? unit.one : unit.many}` : "Provisional"}>{avg ? `avg · ${win} ${win === 1 ? unit.one : unit.many}` : "provisional"}</span>
      </div>
      <ForceChart history={live.history} live height={140} maIterations={win} windowFrom={avg?.from} unit={unit} />
      <StatsTable history={live.history} iterations={win} onIterations={setPick} unit={unit} />
      <p className="muted small">
        {live.runtime === "wasm"
          ? live.field ? `Computed OpenFOAM flow · ${live.snapshots} live snapshots. Keep this tab open until the run finishes.` : "OpenFOAM is meshing and solving locally. Computed airflow appears after the first snapshot. Keep this tab open."
          : "OpenFOAM writes the flow field when it finishes; the 3D flow, surface pressure and animations appear with the result. The run continues on the server if you close this tab."}
      </p>
      <button className="btn danger block" onClick={cancelRun}>
        <Square size={14} fill="currentColor" /> Cancel
      </button>
    </div>
  );
}
