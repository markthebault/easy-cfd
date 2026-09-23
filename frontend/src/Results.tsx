import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  Download,
  Square,
  Terminal,
} from "lucide-react";
import Viewer from "./Viewer";
import {
  active,
  fmt,
  History,
  megabytes,
  Metric,
  parts,
  share,
  time,
  Warnings,
} from "./ui";
import type { Run } from "./types";

export function RunList({
  runs,
  selected,
  onSelect,
}: {
  runs: Run[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  if (!runs.length)
    return <p className="micro sidebar-note">No runs for this design yet.</p>;
  return (
    <div className="run-list" role="list" aria-label="Saved runs">
      {runs.map((r) => (
        <button
          key={r.id}
          role="listitem"
          data-run={r.id}
          className={`run-item ${r.id === selected ? "selected" : ""}`}
          onClick={() => onSelect(r.id)}
          aria-current={r.id === selected}
        >
          <span className={`dot status-${r.status}`} />
          <span className="run-text">
            <span className="run-name">
              {r.name}
              {parts(r)}
            </span>
            <small>
              <span className="chip">{r.settings.quality}</span>{" "}
              {r.status === "completed" && r.result
                ? `Cd ${fmt(r.result.cd, 3)} · `
                : `${r.status} · `}
              {time(r.created)}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function RunActions({
  run,
  onLogs,
  onCancel,
}: {
  run: Run;
  onLogs: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="run-bar compact">
      <div className="button-row">
        <button className="secondary small" onClick={onLogs}>
          <Terminal size={13} />
          Logs
        </button>
        {active(run) ? (
          <button className="secondary small" onClick={onCancel}>
            <Square size={12} />
            Cancel
          </button>
        ) : (
          <a className="secondary small" href={`/api/runs/${run.id}/export`}>
            <Download size={13} />
            Export run
            {run.disk_bytes != null && (
              <small>{megabytes(run.disk_bytes)}</small>
            )}
          </a>
        )}
      </div>
    </div>
  );
}

export function ResultsView({
  current,
  history,
  historyFailed,
  controls,
  field,
  mode,
  axis,
  position,
  theme,
  onBack,
}: {
  current?: Run;
  history: { run: string; points: { iteration: number; cd: number }[] } | null;
  historyFailed: string;
  controls: ReactNode;
  field: string;
  mode: string;
  axis: string;
  position: number;
  theme: string;
  onBack: () => void;
}) {
  if (!current)
    return (
      <div className="empty-state">
        <Activity size={38} />
        <h2>No simulations yet</h2>
        <p>
          Review the model and run a simulation. Only calculated results appear
          here.
        </p>
        <button className="secondary" onClick={onBack}>
          Back to setup <ArrowRight size={15} />
        </button>
      </div>
    );
  const result = current.result;
  return (
    <>
      <div className="fold">
        <div className={`run-status ${current.status}`}>
          <span className="dot" />
          <strong>{current.stage}</strong>
          <span className="run-status-name">
            {current.name}
            {parts(current)}
          </span>
          <span className="run-status-meta">
            {current.settings.speed_kmh} km/h · {current.settings.yaw_deg}° yaw
            · {current.settings.quality} · iteration {current.iteration}
          </span>
          {result && result.warnings.length > 0 && (
            <a className="warning-link" href="#run-details">
              <AlertTriangle size={13} /> {result.warnings.length} warning
              {result.warnings.length > 1 ? "s" : ""}
            </a>
          )}
        </div>
        {current.error && (
          <div className="alert error">
            <AlertTriangle size={18} />
            <pre>{current.error}</pre>
          </div>
        )}
        {result && (
          <div className="metric-grid compact">
            <Metric
              title="Drag"
              value={fmt(result.drag)}
              unit="N"
              detail="Resistance along the car"
            />
            <Metric
              title="Downforce"
              value={fmt(result.downforce)}
              unit="N"
              detail="Positive means downward"
            />
            <Metric
              title="Drag coefficient"
              value={fmt(result.cd, 4)}
              unit="Cd"
              detail={`Reference area ${current.settings.reference_area} m²`}
            />
            <Metric
              title="Lift coefficient"
              value={fmt(result.cl, 4)}
              unit="Cl"
              detail="Negative means downforce"
            />
          </div>
        )}
        <div className="canvas-panel fill">
          {result && controls}
          <Viewer
            geometry={current.geometry}
            geometryBase={`/api/runs/${current.id}/geometry`}
            resultBase={result ? `/api/runs/${current.id}` : undefined}
            field={field}
            mode={result ? mode : "geometry"}
            axis={axis}
            position={position}
            range={result?.ranges[field]}
            theme={theme}
            label={
              result
                ? `${field} · calculated result`
                : "Geometry · awaiting calculated results"
            }
          />
        </div>
      </div>
      <p className="micro">
        Saved output uses the conditions shown above. Changes in the setup panel
        apply to the next run.
      </p>
      {result && (
        <div className="details" id="run-details">
          <Warnings items={result.warnings} />
          {result.breakdown && (
            <>
              <h3 className="section-heading">
                Where the drag comes from
                {!result.breakdown.consistent &&
                  " · unreconciled, see warnings"}
              </h3>
              <div className="metric-grid compact">
                <Metric
                  title="Body drag"
                  value={fmt(result.breakdown.body.drag)}
                  unit="N"
                  detail={`${share(result.breakdown.body.drag, result.drag)} of total · Cd ${fmt(result.breakdown.body.cd, 4)}`}
                />
                {result.breakdown.wheels && (
                  <Metric
                    title="Wheels drag"
                    value={fmt(result.breakdown.wheels.drag)}
                    unit="N"
                    detail={`${share(result.breakdown.wheels.drag, result.drag)} of total · Cd ${fmt(result.breakdown.wheels.cd, 4)}`}
                  />
                )}
                <Metric
                  title="Pressure drag"
                  value={fmt(result.breakdown.pressure_drag)}
                  unit="N"
                  detail={`${share(result.breakdown.pressure_drag, result.drag)} of total drag`}
                />
                <Metric
                  title="Viscous drag"
                  value={fmt(result.breakdown.viscous_drag)}
                  unit="N"
                  detail={`${share(result.breakdown.viscous_drag, result.drag)} of total drag`}
                />
              </div>
            </>
          )}
          <div className="diagnostics">
            <div>
              <h3>Run checks</h3>
              <p>
                <Check size={14} /> Mesh passed geometric checks ·{" "}
                {result.cells.toLocaleString()} cells
              </p>
              {result.blockage_ratio != null && (
                <p>
                  Tunnel blockage {(result.blockage_ratio * 100).toFixed(1)}% of
                  cross-section
                </p>
              )}
              <p>
                {result.force_settled ? (
                  <Check size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}{" "}
                Forces {result.force_settled ? "settled" : "still changing"}
              </p>
              <p>
                {result.residual_converged ? (
                  <Check size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}{" "}
                Residual target{" "}
                {result.residual_converged ? "reached" : "not reached"}
              </p>
              <p>Solver time: {fmt(result.timings.simpleFoam / 60, 1)} min</p>
              {result.refinement && (
                <p>
                  Mesh sensitivity: ΔCd {fmt(result.refinement.delta_cd, 4)} ·
                  ΔCl {fmt(result.refinement.delta_cl, 4)}
                </p>
              )}
              <details className="plain-details">
                <summary>Near-wall resolution · y+</summary>
                {result.y_plus.map((v) => (
                  <p key={v.patch}>
                    {v.patch}: mean {fmt(v.mean, 1)}, range {fmt(v.minimum, 1)}–
                    {fmt(v.maximum, 1)}
                  </p>
                ))}
                <p className="micro">
                  Wall functions require appropriate near-wall resolution.
                  Inspect these values before trusting forces.
                </p>
              </details>
            </div>
            <div>
              <h3>Force history</h3>
              {history?.run === current.id ? (
                <History history={history.points} />
              ) : historyFailed === current.id ? (
                <p className="micro warning-text" role="status">
                  Could not load force history. Retrying…
                </p>
              ) : (
                <p className="micro">Loading force history…</p>
              )}
              <p className="micro">
                Drag coefficient over solver iterations. Values are averaged
                over the last 50 iterations, or all available if fewer.
              </p>
            </div>
          </div>
          <p className="micro">
            Flow lines show average flow, not time-resolved turbulence. Wall
            speed is zero on stationary body surfaces; use a slice to inspect
            surrounding air.
          </p>
        </div>
      )}
    </>
  );
}
