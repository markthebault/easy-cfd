// Side-by-side comparison: two stages with synchronised cameras and shared colour ranges,
// delta cards, and warnings when the two runs are not like-for-like.

import { ArrowDown, ArrowUp, TriangleAlert, X } from "lucide-react";
import { G, type Settings } from "../solver/types";
import { useStore } from "../store/store";
import { app, closeCompare } from "../store/app";
import type { LoadedRun } from "../store/types";
import type { CameraState } from "../viz/stage";
import { LegendStack } from "./Legend";
import { StageView, stages } from "./StageView";
import { ViewBar } from "./Chrome";
import { VizDock } from "./VizDock";
import { conditionsLine, fmt, fmtDate, groupsLine, qualityLabel, signed } from "./format";

function conditionDiffs(a: Settings, b: Settings): string[] {
  const out: string[] = [];
  if (a.speed_kmh !== b.speed_kmh) out.push(`speed ${a.speed_kmh} vs ${b.speed_kmh} km/h`);
  if (a.yaw_deg !== b.yaw_deg) out.push(`yaw ${a.yaw_deg}° vs ${b.yaw_deg}°`);
  if (a.reference_area !== b.reference_area) out.push(`reference area ${a.reference_area} vs ${b.reference_area} m²`);
  if (a.density !== b.density) out.push(`air density ${a.density} vs ${b.density}`);
  if (a.moving_ground !== b.moving_ground) out.push("moving ground differs");
  if (a.wheels !== b.wheels) out.push("rotating wheels differ");
  if (qualityLabel(a) !== qualityLabel(b)) out.push(`quality ${qualityLabel(a)} vs ${qualityLabel(b)}`);
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

export function CompareView() {
  const cmp = useStore(app, (s) => s.compare);
  const viz = useStore(app, (s) => s.viz);
  const dark = useStore(app, (s) => s.dark);
  if (!cmp) return null;
  const { a, b } = cmp;
  const ra = a.doc.result, rb = b.doc.result;
  const cond = conditionDiffs(a.doc.settings, b.doc.settings);
  const parts = partDiffs(a, b);
  const sync = (from: "cmpA" | "cmpB") => (c: CameraState) => stages[from === "cmpA" ? "cmpB" : "cmpA"]?.applyCamera(c);
  const side = (r: LoadedRun, id: "cmpA" | "cmpB", tag: string) => (
    <div className="compare-side">
      <StageView
        id={id}
        className="stage-host compare-stage"
        parts={r.parts}
        partsKey={`cmp:${r.doc.id}`}
        surface={r.surface}
        field={r.field}
        ranges={r.ranges}
        viz={viz}
        dark={dark}
        box={null}
        helpers={false}
        gizmo={{ right: 12, bottom: 12, size: 72 }}
        onCamera={sync(id)}
      />
      <div className="compare-tag glass">
        <b>{tag}</b> {r.doc.designName}
        <span className="muted small">{conditionsLine(r.doc.settings)} · {fmtDate(r.doc.createdAt)}</span>
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
          <Delta label="Drag" a={ra.drag} b={rb.drag} unit="N" digits={0} better="lower" />
          <Delta label="Downforce" note="negative = lift" a={ra.downforce / G} b={rb.downforce / G} unit="kg" digits={1} better="higher" />
          <Delta label="Cd" a={ra.cd} b={rb.cd} unit="" digits={4} better="lower" />
          <Delta label="Cl" a={ra.cl} b={rb.cl} unit="" digits={4} better={null} />
        </div>
        {(cond.length > 0 || parts.length > 0) && (
          <div className="compare-warn">
            {cond.length > 0 && <p><TriangleAlert size={14} /> <b>Conditions differ:</b> {cond.join(" · ")}. The difference is not only due to the shape.</p>}
            {parts.length > 0 && <p className="muted"><b>Parts differ:</b> {parts.join(" · ")}</p>}
          </div>
        )}
        <button className="icon-btn compare-close" aria-label="Close comparison" onClick={closeCompare}><X size={18} /></button>
      </div>
      <ViewBar ids={["cmpA", "cmpB"]} />
      <VizDock field={a.field ?? b.field} particles surface={!!a.surface || !!b.surface} stageIds={["cmpA", "cmpB"]} />
      <LegendStack viz={viz} ranges={a.ranges} hasSurface={!!a.surface} hasField={!!a.field} />
    </div>
  );
}
