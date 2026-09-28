// Live solving view: progress, streaming force chart and the latest (provisional) coefficients.

import { CircleAlert, Square } from "lucide-react";
import { resolvePreset } from "../solver/types";
import { useStore } from "../store/store";
import { app } from "../store/app";
import { cancelRun, dismissLive } from "../store/runs";
import { ForceChart } from "./ForceChart";
import { conditionsLine, fmt, fmtCells, fmtDuration, fmtInt } from "./format";

const STAGE: Record<string, string> = {
  preparing: "Preparing the grid",
  solving: "Solving the flow",
  finishing: "Averaging forces",
  saving: "Sampling the flow for display",
};

export function LivePanel() {
  const live = useStore(app, (s) => s.live);
  if (!live) return null;
  const last = live.history[live.history.length - 1];
  const passTime = live.targetTime / resolvePreset(live.settings).passes;
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
        <span className="eyebrow"><span className="rec" /> Live</span>
        <h2>{STAGE[live.stage]}</h2>
        <p className="muted small">{live.designName} · {conditionsLine(live.settings)}</p>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(live.fraction * 100)}>
        <div className={`progress-fill ${live.stage === "preparing" ? "indeterminate" : ""}`} style={{ width: live.stage === "preparing" ? "30%" : `${live.fraction * 100}%` }} />
      </div>
      <div className="live-stats">
        <div><b>{fmt(live.time, 2)}<small> / {fmt(live.targetTime, 2)} s</small></b><span>simulated time</span></div>
        <div><b>{fmtInt(live.steps)}</b><span>steps</span></div>
        <div><b>{fmtDuration(live.elapsed)}</b><span>elapsed{Number.isFinite(remaining) ? ` · ~${fmtDuration(remaining)} left` : ""}</span></div>
        <div><b>{live.cells ? fmtCells(live.cells) : "–"}</b><span>cells</span></div>
      </div>
      <div className="live-coeffs">
        <div><span>Cd</span><b>{last ? last.cd.toFixed(4) : "–"}</b></div>
        <div><span>Cl</span><b>{last ? last.cl.toFixed(4) : "–"}</b></div>
        <span className="badge warn">provisional</span>
      </div>
      <ForceChart history={live.history} passTime={passTime} live height={140} />
      <p className="muted small">
        {live.field
          ? `The 3D flow updates every few seconds (${live.snapshots} snapshot${live.snapshots === 1 ? "" : "s"}). It is the solver's current state, not converged yet.`
          : "The flow appears here after the first snapshot."}
      </p>
      <button className="btn danger block" onClick={cancelRun} disabled={live.stage === "saving"}>
        <Square size={14} fill="currentColor" /> Cancel
      </button>
    </div>
  );
}
