import type { LoadedRun } from "../store/types";
import { G } from "../solver/types";
import { fmt } from "./format";

export function AeroBalancePanel({ run }: { run: LoadedRun }) {
  const r = run.doc.result,
    b = r.balance;
  if (!b)
    return (
      <div className="breakdown" data-testid="aero-balance-unavailable">
        <div className="section-title">Aerodynamic balance</div>
        <p className="muted small">
          {r.aero
            ? "Confirm valid front and rear axle positions before running to calculate equivalent loads."
            : "This run has no saved wall moments. Run again with the updated solver to calculate balance."}
        </p>
      </div>
    );
  const traces: ["frontLift" | "rearLift" | "pitch", string, string, string][] =
    [
      ["frontLift", "Front lift", "N", "#70acff"],
      ["rearLift", "Rear lift", "N", "#67d6be"],
      ["pitch", "Pitching moment", "N m", "#ffaa63"],
    ];
  return (
    <div className="breakdown" data-testid="aero-balance">
      <div className="section-title">
        Equivalent aerodynamic axle loads{" "}
        <span className="muted">{fmt(b.wheelbase, 3)} m wheelbase</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Axle</th>
            <th>Lift (+) / downforce (−)</th>
            <th>kgf</th>
            <th>Cl</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Front</th>
            <td className="num">{fmt(b.frontLift, 1)} N</td>
            <td className="num">{fmt(b.frontLift / G, 1)}</td>
            <td className="num">{fmt(b.frontCl, 4)}</td>
          </tr>
          <tr>
            <th>Rear</th>
            <td className="num">{fmt(b.rearLift, 1)} N</td>
            <td className="num">{fmt(b.rearLift / G, 1)}</td>
            <td className="num">{fmt(b.rearCl, 4)}</td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        Pitch {fmt(b.pitch, 2)} N m{" "}
        <span className="muted">(positive = nose-up)</span>
      </p>
      <p className="small">
        {b.frontDownforcePercent === undefined
          ? b.percentageReason
          : `Front share of downforce: ${fmt(b.frontDownforcePercent, 1)}%`}
      </p>
      <p className="muted small">
        Road-plane reference [{r.aero?.origin.map((v) => fmt(v, 3)).join(", ")}]
        m. Includes drag acting above the road. These are aerodynamic forces,
        not actual tyre loads; kgf = N / 9.80665.
      </p>
      <div className="balance-history">
        {traces.map(([key, label, unit, colour]) => {
          const history = r.history.filter((h) => Number.isFinite(h[key]));
          if (history.length < 2) return null;
          const values = history.map((h) => h[key]!);
          const low = Math.min(0, ...values),
            high = Math.max(0, ...values),
            span = high - low || 1;
          const thin = history.filter(
            (_, i) => i % Math.max(1, Math.floor(history.length / 180)) === 0,
          );
          const start = history[0].time,
            end = history.at(-1)!.time;
          const path = thin
            .map(
              (h, i) =>
                `${i ? "L" : "M"}${4 + (292 * (h.time - start)) / (end - start || 1)},${64 - (52 * (h[key]! - low)) / span}`,
            )
            .join(" ");
          const band = r.balanceBands?.[key];
          return (
            <div key={key}>
              <div className="section-title">
                {label}
                <span className="muted">
                  {unit}
                  {band !== undefined && Number.isFinite(band)
                    ? ` · observed spread ±${fmt(band, 2)}`
                    : ""}
                </span>
              </div>
              <svg
                viewBox="0 0 300 76"
                role="img"
                aria-label={`${label} history in ${unit}`}
              >
                <line
                  x1="4"
                  y1={64 + (52 * low) / span}
                  x2="296"
                  y2={64 + (52 * low) / span}
                  stroke="currentColor"
                  opacity=".2"
                />
                <path d={path} fill="none" stroke={colour} strokeWidth="1.6" />
              </svg>
            </div>
          );
        })}
      </div>
      <p className="field-hint">
        {r.provenance?.aggregation === "mean-of-levels" &&
          "Histories show the fine grid; reported force/moment means include both grids. "}
        History axis:{" "}
        {r.engine === "openfoam"
          ? "OpenFOAM iteration"
          : "WebGPU pseudo-time (s)"}
        . Observed spread describes this averaging window, not physical
        prediction uncertainty.
      </p>
    </div>
  );
}
