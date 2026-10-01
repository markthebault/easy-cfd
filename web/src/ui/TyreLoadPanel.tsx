import { useState } from "react";
import { G } from "../solver/types";
import { estimateTyreLoads, weightInputError } from "../solver/tyreLoads";
import { assessTyreLoads } from "../store/runs";
import type { LoadedRun } from "../store/types";
import { assessedAxles, assessedResult } from "../store/axleAnalysis";
import { VehicleWeightFields } from "./VehicleWeightFields";
import { fmt, signed } from "./format";

export function TyreLoadPanel({run}: {run: LoadedRun}) {
  const inputs = run.doc.tyreLoadAssessment?.inputs ?? run.doc.settings;
  const analysis = assessedResult(run.doc);
  const axles = assessedAxles(run.doc);
  const loads = estimateTyreLoads(analysis.balance, inputs);
  const [expanded, setExpanded] = useState(!loads);
  return <div className="breakdown tyre-loads" data-testid="tyre-loads">
    <div className="section-title">Load on the tyres<span className="muted">front / rear pair</span></div>
    {analysis.balance && axles?.source === "wheels" && <p className="field-hint" data-testid="detected-wheel-axles">Axles detected from the saved wheel centres · {fmt(analysis.balance.wheelbase,3)} m wheelbase.</p>}
    {loads ? <>
      <div className="tyre-load-cards">
        {(["front", "rear"] as const).map(key => <div className="card" key={key} data-testid={`tyre-load-${key}`}>
          <span className="card-label">{key === "front" ? "Front tyres" : "Rear tyres"}</span>
          <span className="card-value">{loads[key].totalN < 0 ? "Unloaded" : fmt(loads[key].totalN/G, 1)}{loads[key].totalN >= 0 && <small> kgf</small>}</span>
          <span className="card-note">{fmt(loads[key].totalN, 0)} N · {loads[key].totalN < 0 ? "equilibrium demand" : "combined vertical load"}</span>
        </div>)}
      </div>
      <table aria-label="Tyre load contributions">
        <thead><tr><th>Contribution</th><th>Front (N)</th><th>Rear (N)</th></tr></thead>
        <tbody>
          <tr><th>Static weight</th><td className="num">{fmt(loads.front.staticN, 0)}</td><td className="num">{fmt(loads.rear.staticN, 0)}</td></tr>
          <tr><th>Aerodynamic change</th><td className="num">{signed(loads.front.aerodynamicN, 1)}</td><td className="num">{signed(loads.rear.aerodynamicN, 1)}</td></tr>
        </tbody>
      </table>
      <p className="field-hint">Positive aerodynamic change adds load; lift removes it. These are steady estimates on a level road. Braking, cornering, bumps and suspension motion are excluded. No left/right split is assumed.</p>
      {!loads.contactFeasible && <p className="inline-error" role="status">A negative estimate indicates loss of tyre contact. The fixed-pose model no longer predicts a physical support load.</p>}
    </> : <p className="field-hint" data-testid="tyre-loads-unavailable">{!analysis.balance
      ? !run.doc.result.aero ? "This run has no saved aerodynamic moments. Run again with the updated solver to calculate tyre loads."
        : "No clear front/rear wheel pairs were found. Set and confirm axle positions in Conditions for the next run."
      : weightInputError(inputs) ?? "Enter car mass and front weight percentage to estimate the total tyre loads."}</p>}
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{loads ? `Weight inputs · ${fmt(loads.massKg,0)} kg · ${fmt(loads.frontWeightPercent,1)}% front` : "Car weight inputs"}</summary>
      <VehicleWeightFields value={inputs} onChange={patch => {void assessTyreLoads(patch);}} />
      <small className="field-hint">Saved with this result as a separate assessment. Adjusting weight inputs does not rerun or change the CFD solution.</small>
    </details>
  </div>;
}
