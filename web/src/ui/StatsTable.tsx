// Mean, median, min and max of Cd and Cl over the last few flow passes, with a window picker.

import type { ForceSample } from "../solver/types";
import { PASSES, type HistoryUnit } from "./historyUnit";
import { trailingStats } from "./windowStats";

/** Default window: about 30 % of the run (passes), or the solver's own averaging (iterations). */
export function defaultWindow(length: number, unit: HistoryUnit = PASSES) {
  if (unit !== PASSES) return unit.choices[0];
  const want = Math.min(5, Math.max(1, 0.3 * length));
  return unit.choices.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

interface Props {
  history: ForceSample[];
  passTime: number;
  passes: number;
  onPasses: (p: number) => void;
  unit?: HistoryUnit;
}

export function StatsTable({ history, passTime, passes, onPasses, unit = PASSES }: Props) {
  const s = trailingStats(history, passTime, passes);
  const done = history.length ? history[history.length - 1].time / passTime : 0;
  const rows = s ? ([["Cd", s.cd], ["Cl", s.cl]] as const) : [];
  return (
    <div className="window-stats" data-testid="window-stats">
      <div className="stats-head">
        <span className="section-title">Moving average</span>
        <label className="muted small">
          last{" "}
          <select value={passes} aria-label={`Averaging window in ${unit.axis}`} onChange={(e) => onPasses(Number(e.target.value))}>
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
      {s && done < passes && <p className="muted small">Only {unit === PASSES ? done.toFixed(1) : Math.round(done)} {unit.many} so far; the window covers the whole run.</p>}
    </div>
  );
}
