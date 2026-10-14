// Mean, median, min and max of Cd and Cl over the last few solver iterations, with a window picker.

import type { ForceSample } from "../solver/types";
import { ITERATIONS, type HistoryUnit } from "./historyUnit";
import { trailingStats } from "./windowStats";

interface Props {
  history: ForceSample[];
  iterations: number;
  onIterations: (p: number) => void;
  unit?: HistoryUnit;
}

export function StatsTable({ history, iterations, onIterations, unit = ITERATIONS }: Props) {
  const s = trailingStats(history, iterations);
  const done = history.length ? history[history.length - 1].time : 0;
  const rows = s ? ([["Cd", s.cd], ["Cl", s.cl]] as const) : [];
  return (
    <div className="window-stats" data-testid="window-stats">
      <div className="stats-head">
        <span className="section-title">Moving average</span>
        <label className="muted small">
          last{" "}
          <select value={iterations} aria-label={`Averaging window in ${unit.axis}`} onChange={(e) => onIterations(Number(e.target.value))}>
            {unit.choices.map((p) => <option key={p} value={p}>{p} {p === 1 ? unit.one : unit.many}</option>)}
          </select>
        </label>
      </div>
      {s ? (
        <table className="stats-table">
          <thead>
            <tr><th /><th>mean</th><th>min</th><th>median</th><th>max</th><th>spread</th></tr>
          </thead>
          <tbody>
            {rows.map(([name, v]) => (
              <tr key={name}>
                <td>{name}</td>
                <td><b>{v.mean.toFixed(4)}</b></td>
                <td>{v.min.toFixed(4)}</td>
                <td>{v.median.toFixed(4)}</td>
                <td>{v.max.toFixed(4)}</td>
                <td className="muted">±{(0.5 * (v.max - v.min)).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Statistics appear after the first few samples.</p>
      )}
      {s && done < iterations && <p className="muted small">Only {Math.round(done)} {unit.many} so far; the window covers the whole run.</p>}
    </div>
  );
}
