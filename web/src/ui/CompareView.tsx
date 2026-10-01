// Side-by-side comparison: two stages with synchronised cameras and shared colour ranges,
// delta cards, and warnings when the two runs are not like-for-like.

import { ArrowDown, ArrowUp, TriangleAlert, X } from "lucide-react";
import { G, type Settings } from "../solver/types";
import { estimateTyreLoads } from "../solver/tyreLoads";
import { assessedAxles, assessedResult } from "../store/axleAnalysis";
import { useStore } from "../store/store";
import { app, closeCompare } from "../store/app";
import type { LoadedRun } from "../store/types";
import type { CameraState } from "../viz/stage";
import { LegendStack } from "./Legend";
import { StageView, stages } from "./StageView";
import { ViewBar } from "./Chrome";
import { VizDock } from "./VizDock";
import { conditionsLine, fmt, fmtDate, groupForces, groupsLine, qualityLabel, signed } from "./format";

function conditionDiffs(a: Settings, b: Settings): string[] {
  const out: string[] = [];
  const ea = a.engine === "openfoam" ? "OpenFOAM" : "WebGPU", eb = b.engine === "openfoam" ? "OpenFOAM" : "WebGPU";
  if (ea !== eb) out.push(`solver ${ea} vs ${eb}`);
  if (a.speed_kmh !== b.speed_kmh) out.push(`speed ${a.speed_kmh} vs ${b.speed_kmh} km/h`);
  if (a.yaw_deg !== b.yaw_deg) out.push(`yaw ${a.yaw_deg}° vs ${b.yaw_deg}°`);
  if (a.reference_area !== b.reference_area) out.push(`reference area ${a.reference_area} vs ${b.reference_area} m²`);
  if (a.density !== b.density) out.push(`air density ${a.density} vs ${b.density}`);
  if (a.moving_ground !== b.moving_ground) out.push("moving ground differs");
  if (a.wheels !== b.wheels) out.push("rotating wheels differ");
  if (qualityLabel(a) !== qualityLabel(b)) out.push(`quality ${qualityLabel(a)} vs ${qualityLabel(b)}`);
  if (a.profile !== b.profile) out.push(`profile ${a.profile ?? "legacy"} vs ${b.profile ?? "legacy"}`);
  if (JSON.stringify(a.simulation_box) !== JSON.stringify(b.simulation_box)) out.push("simulation box differs");
  return out;
}

function partDiffs(a: LoadedRun, b: LoadedRun): string[] {
  const ga = groupsLine(a.doc.geometry), gb = groupsLine(b.doc.geometry);
  if ((ga || gb) && ga !== gb) {
    // Group-level difference first; it is what the user switched.
    const out = [`groups A: ${ga || "—"} · B: ${gb || "—"}`];
    const da = a.doc.geometry.dimensions, db = b.doc.geometry.dimensions;
    if (da.some((v, i) => Math.abs(v - db[i]) > 0.005))
      out.push(`size ${da.map((v) => v.toFixed(2)).join("×")} vs ${db.map((v) => v.toFixed(2)).join("×")} m`);
    return out;
  }
  const pa = new Map(a.doc.geometry.parts.filter((p) => p.enabled).map((p) => [p.key, p]));
  const pb = new Map(b.doc.geometry.parts.filter((p) => p.enabled).map((p) => [p.key, p]));
  const out: string[] = [];
  const onlyA = [...pa.keys()].filter((k) => !pb.has(k)).map((k) => pa.get(k)!.name);
  const onlyB = [...pb.keys()].filter((k) => !pa.has(k)).map((k) => pb.get(k)!.name);
  if (onlyA.length) out.push(`only in A: ${onlyA.slice(0, 4).join(", ")}${onlyA.length > 4 ? "…" : ""}`);
  if (onlyB.length) out.push(`only in B: ${onlyB.slice(0, 4).join(", ")}${onlyB.length > 4 ? "…" : ""}`);
  const roles = [...pa.keys()].filter((k) => pb.has(k) && pa.get(k)!.role !== pb.get(k)!.role);
  if (roles.length) out.push(`${roles.length} part role${roles.length > 1 ? "s" : ""} changed`);
  const da = a.doc.geometry.dimensions, db = b.doc.geometry.dimensions;
  if (da.some((v, i) => Math.abs(v - db[i]) > 0.005))
    out.push(`size ${da.map((v) => v.toFixed(2)).join("×")} vs ${db.map((v) => v.toFixed(2)).join("×")} m`);
  if (JSON.stringify(a.doc.importOptions) !== JSON.stringify(b.doc.importOptions)) out.push("import options differ");
  return out;
}

function Delta({ label, a, b, unit, digits, better, note }: { label: string; a: number; b: number; unit: string; digits: number; better: "lower" | "higher" | null; note?: string }) {
  const d = b - a;
  const rel = Math.abs(a) > 1e-9 ? (100 * d) / Math.abs(a) : NaN;
  const good = better === null || Math.abs(d) < 1e-12 ? null : better === "lower" ? d < 0 : d > 0;
  return (
    <div className="card delta">
      <span className="card-label">{label}{note && <span className="card-note"> · {note}</span>}</span>
      <span className="delta-pair"><span>{fmt(a, digits)}</span><span className="muted">→</span><b>{fmt(b, digits)}</b><small>{unit}</small></span>
      <span className={`delta-change ${good === null ? "" : good ? "good" : "bad"}`}>
        {d > 0 ? <ArrowUp size={13} /> : d < 0 ? <ArrowDown size={13} /> : null}
        {signed(d, digits)} {unit} {Number.isFinite(rel) && `(${signed(rel, 1)} %)`}
      </span>
    </div>
  );
}

/** Per-group downforce and drag of both runs, for the groups either run simulated. */
function GroupDeltas({ a, b }: { a: LoadedRun; b: LoadedRun }) {
  const ga = groupForces(a.doc.result, a.doc.geometry), gb = groupForces(b.doc.result, b.doc.geometry);
  if (a.doc.result.reconciliation?.complete === false || b.doc.result.reconciliation?.complete === false) return null;
  if (!ga.length || !gb.length) return null;
  const ids = [...new Set([...ga.map((g) => g.id), ...gb.map((g) => g.id)])];
  if (ids.length < 2) return null;
  const val = (list: typeof ga, id: string) => list.find((g) => g.id === id);
  return (
    <table className="compare-groups" data-testid="compare-groups">
      <thead>
        <tr><th /><th colSpan={3}>Downforce (kgf)</th><th colSpan={3}>Drag (N)</th></tr>
        <tr><th /><th>A</th><th>B</th><th>Δ</th><th>A</th><th>B</th><th>Δ</th></tr>
      </thead>
      <tbody>
        {ids.map((id) => {
          const x = val(ga, id), y = val(gb, id);
          const name = (x ?? y)!.name;
          const cell = (v: number | undefined, d: number) => (v === undefined ? "–" : fmt(v, d));
          const delta = (p: number | undefined, q: number | undefined, d: number) => p === undefined || q === undefined ? "unavailable" : signed(q - p, d);
          return (
            <tr key={id}>
              <th scope="row">{name}</th>
              <td>{cell(x?.downforceKg, 1)}</td><td>{cell(y?.downforceKg, 1)}</td><td className="d">{delta(x?.downforceKg, y?.downforceKg, 1)}</td>
              <td>{cell(x?.drag, 0)}</td><td>{cell(y?.drag, 0)}</td><td className="d">{delta(x?.drag, y?.drag, 0)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function CompareView() {
  const cmp = useStore(app, (s) => s.compare);
  const viz = useStore(app, (s) => s.viz);
  const dark = useStore(app, (s) => s.dark);
  if (!cmp) return null;
  const { a, b } = cmp;
  const ra = assessedResult(a.doc), rb = assessedResult(b.doc);
  const weightA = a.doc.tyreLoadAssessment?.inputs ?? a.doc.settings;
  const weightB = b.doc.tyreLoadAssessment?.inputs ?? b.doc.settings;
  const tyresA = estimateTyreLoads(ra.balance, weightA), tyresB = estimateTyreLoads(rb.balance, weightB);
  const cond = conditionDiffs(a.doc.settings, b.doc.settings);
  if(JSON.stringify(assessedAxles(a.doc))!==JSON.stringify(assessedAxles(b.doc))) cond.push("axle definitions differ");
  if(JSON.stringify(ra.aero?.origin)!==JSON.stringify(rb.aero?.origin)) cond.push("moment origins differ");
  if(!ra.provenance?.version || !rb.provenance?.version || ra.provenance.version!==rb.provenance.version) cond.push("solver versions differ or are unavailable");
  if(ra.provenance?.pipeline!==rb.provenance?.pipeline) cond.push("solver pipeline identities differ or are unavailable");
  const parts = partDiffs(a, b);
  const sync = (from: "cmpA" | "cmpB") => (c: CameraState) => stages[from === "cmpA" ? "cmpB" : "cmpA"]?.applyCamera(c);
  const side = (r: LoadedRun, id: "cmpA" | "cmpB", tag: string) => (
    <div className="compare-side">
      <StageView
        id={id}
        className="stage-host compare-stage"
        parts={r.parts}
        partsKey={`cmp:${r.doc.id}`}
        axles={assessedAxles(r.doc)}
        surface={r.surface}
        field={r.field}
        ranges={r.ranges}
        viz={viz}
        driving={r.doc.settings}
        forces={assessedResult(r.doc)}
        forceScale={Math.max(Math.abs(ra.drag), Math.abs(ra.lift), Math.abs(ra.side), Math.abs(rb.drag), Math.abs(rb.lift), Math.abs(rb.side), 1e-9)}
        forceLength={Math.max(a.doc.geometry.dimensions[0], b.doc.geometry.dimensions[0])}
        dark={dark}
        box={null}
        helpers={false}
        gizmo={{ right: 12, bottom: 12, size: 72 }}
        onCamera={sync(id)}
      />
      <div className="compare-tag glass">
        <b>{tag}</b> {r.doc.designName}
        <span className="muted small">{r.doc.result.engine === "openfoam" ? "OpenFOAM" : "WebGPU"} · {conditionsLine(r.doc.settings)} · {fmtDate(r.doc.createdAt)}</span>
        {groupsLine(r.doc.geometry) && <span className="small groups-line">Groups: {groupsLine(r.doc.geometry)}</span>}
      </div>
    </div>
  );
  return (
    <div className="compare">
      <div className="compare-stages">
        {side(a, "cmpA", "A")}
        {side(b, "cmpB", "B")}
      </div>
      <div className="compare-top glass">
        <div className="compare-cards">
          <Delta label="Drag" a={ra.drag} b={rb.drag} unit="N" digits={0} better={null} />
          <Delta label="Downforce" note="negative = lift" a={ra.downforce / G} b={rb.downforce / G} unit="kgf" digits={1} better={null} />
          <Delta label="Cd" a={ra.cd} b={rb.cd} unit="" digits={4} better={null} />
          <Delta label="Cl" a={ra.cl} b={rb.cl} unit="" digits={4} better={null} />
        </div>
        {ra.balance && rb.balance && <div className="compare-cards"><Delta label="Front lift" a={ra.balance.frontLift} b={rb.balance.frontLift} unit="N" digits={1} better={null}/><Delta label="Rear lift" a={ra.balance.rearLift} b={rb.balance.rearLift} unit="N" digits={1} better={null}/><Delta label="Pitching moment" a={ra.balance.pitch} b={rb.balance.pitch} unit="N m" digits={2} better={null}/></div>}
        {tyresA && tyresB && <>
          <div className="compare-cards" data-testid="compare-tyre-loads">
            <Delta label="Front tyre pair" a={tyresA.front.totalN} b={tyresB.front.totalN} unit="N" digits={0} better={null}/>
            <Delta label="Rear tyre pair" a={tyresA.rear.totalN} b={tyresB.rear.totalN} unit="N" digits={0} better={null}/>
          </div>
          <p className="compare-grid muted small">Steady level-road tyre loads include static weight and aerodynamic load.
            {(weightA.vehicle_mass_kg !== weightB.vehicle_mass_kg || weightA.front_weight_percent !== weightB.front_weight_percent) && " Weight inputs differ; the load change includes static weight differences."}
            {(!tyresA.contactFeasible || !tyresB.contactFeasible) && " A negative demand indicates loss of contact; the fixed-pose estimate is no longer physical."}
          </p>
        </>}
        <p className="compare-grid muted small">{ra.cdBand === undefined || rb.cdBand === undefined ? "Significance unknown: averaging-window variation is unavailable." : Math.abs(rb.cd-ra.cd)<=Math.max(ra.cdBand+rb.cdBand,Math.abs(ra.meshSensitivity?.dCd ?? 0),Math.abs(rb.meshSensitivity?.dCd ?? 0)) ? "Drag change is smaller than observed variation or measured grid sensitivity; the ranking is unresolved." : "Drag change exceeds recorded variation. Physical prediction uncertainty remains unknown."}</p>
        <p className="compare-grid muted small">{ra.clBand === undefined || rb.clBand === undefined ? "Lift significance unknown: averaging-window variation is unavailable." : Math.abs(rb.cl-ra.cl) <= Math.max(ra.clBand+rb.clBand,Math.abs(ra.meshSensitivity?.dCl ?? 0),Math.abs(rb.meshSensitivity?.dCl ?? 0)) ? "Lift change is smaller than observed variation or measured grid sensitivity; the ranking is unresolved." : "Lift change exceeds recorded variation; physical uncertainty remains unknown."}</p>
        {ra.balance && rb.balance && <p className="compare-grid muted small">{(["frontLift","rearLift","pitch"] as const).map(k=>{const x=ra.balanceBands?.[k],y=rb.balanceBands?.[k];const threshold=Math.max((x??0)+(y??0),Math.abs(ra.meshSensitivity?.[k]??0),Math.abs(rb.meshSensitivity?.[k]??0));return `${k === "pitch" ? "Pitch" : k === "frontLift" ? "Front load" : "Rear load"}: ${x === undefined || y === undefined ? "significance unknown" : Math.abs(rb.balance![k]-ra.balance![k]) <= threshold ? "change within observed variation or grid sensitivity" : "change exceeds recorded variation"}`;}).join(" · ")}. A change in balance is not automatically an improvement; physical uncertainty remains unknown.</p>}
        {(ra.reconciliation?.complete === false || rb.reconciliation?.complete === false) && <p className="compare-grid muted small">Component attribution did not reconcile with whole-car forces or moments. Group deltas are unavailable; inspect the run diagnostics.</p>}
        <GroupDeltas a={a} b={b} />
        {ra.gridId && rb.gridId && ra.gridId !== rb.gridId && (
          <p className="compare-grid muted small"><TriangleAlert size={13} /> The runs used different grids; the grid can contribute to the difference. Grid independence has not been established.</p>
        )}
        {ra.gridId && ra.gridId === rb.gridId && <p className="compare-grid muted small">Same grid for both runs: this controls grid placement but does not establish physical accuracy.</p>}
        {(cond.length > 0 || parts.length > 0) && (
          <div className="compare-warn">
            {cond.length > 0 && <p><TriangleAlert size={14} /> <b>Conditions differ:</b> {cond.join(" · ")}. The difference is not only due to the shape.</p>}
            {parts.length > 0 && <p className="muted"><b>Parts differ:</b> {parts.join(" · ")}</p>}
          </div>
        )}
        <button className="icon-btn compare-close" aria-label="Close comparison" onClick={closeCompare}><X size={18} /></button>
      </div>
      <ViewBar ids={["cmpA", "cmpB"]} />
      <VizDock friction={!!a.surface?.some(s=>s?.stressValid?.some(v=>v===1)) && !!b.surface?.some(s=>s?.stressValid?.some(v=>v===1))} field={a.field ?? b.field} particles surface={!!a.surface?.some(Boolean) && !!b.surface?.some(Boolean)} forces={ra} driving={a.doc.settings} stageIds={["cmpA", "cmpB"]} />
      <LegendStack viz={viz} ranges={a.ranges} hasSurface={!!a.surface} hasField={!!a.field} />
    </div>
  );
}
