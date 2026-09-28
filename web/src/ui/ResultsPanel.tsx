// Results: headline forces, where the drag comes from, force history and run details.

import { useState } from "react";
import { CheckCircle2, Columns2, FileJson, FileSpreadsheet, Image, Pencil, TriangleAlert } from "lucide-react";
import { resolvePreset } from "../solver/types";
import { useStore } from "../store/store";
import { app, openDesign } from "../store/app";
import { exportCSV, exportJSON, exportPNG, startCompare } from "../store/runs";
import type { LoadedRun } from "../store/types";
import { ForceChart } from "./ForceChart";
import { stages } from "./StageView";
import { conditionsLine, fmt, fmtCells, fmtDate, fmtDuration, fmtInt, groupsLine, pct, verticalLoad } from "./format";

// Indicative spread over the averaging window, shown only when it is meaningful.
function bandText(b: number | undefined) {
  return b !== undefined && Number.isFinite(b) && b >= 0.0005 ? `± ${fmt(b, 3)} · ` : "";
}

export function Headline({ run }: { run: LoadedRun }) {
  const r = run.doc.result;
  const v = verticalLoad(r);
  return (
    <div className="headline">
      <div className="card hero" data-testid="card-vertical">
        <span className="card-label">{v.label}</span>
        <span className="card-value">{fmt(v.kg, 1)}<small> kg</small></span>
        <span className="card-sub">{fmtInt(v.newtons)} N {v.label === "Downforce" ? "pushing the car down" : "lifting the car"}</span>
      </div>
      <div className="card" data-testid="card-drag">
        <span className="card-label">Drag</span>
        <span className="card-value">{fmtInt(r.drag)}<small> N</small></span>
        <span className="card-sub">{fmt(r.drag / 9.80665, 1)} kgf</span>
      </div>
      <div className="card" data-testid="card-cd">
        <span className="card-label">Cd</span>
        <span className="card-value mono">{fmt(r.cd, 4)}</span>
        <span className="card-sub">{bandText(r.cdBand)}CdA {fmt(r.cd * run.doc.settings.reference_area, 3)} m²</span>
      </div>
      <div className="card" data-testid="card-cl">
        <span className="card-label">Cl</span>
        <span className="card-value mono">{fmt(r.cl, 4)}</span>
        <span className="card-sub">{bandText(r.clBand)}{r.cl < 0 ? "negative = downforce" : "positive = lift"}</span>
      </div>
    </div>
  );
}

function Breakdown({ run }: { run: LoadedRun }) {
  const b = run.doc.result.breakdown;
  const total = run.doc.result.drag;
  const rows = [
    { group: "Body", label: "Pressure", v: b.bodyPressure[0] },
    { group: "Body", label: "Friction", v: b.bodyViscous[0] },
    { group: "Wheels", label: "Pressure", v: b.wheelPressure[0] },
    { group: "Wheels", label: "Friction", v: b.wheelViscous[0] },
  ];
  const max = Math.max(...rows.map((r) => Math.abs(r.v)), 1e-9);
  const body = b.bodyPressure[0] + b.bodyViscous[0];
  const wheels = b.wheelPressure[0] + b.wheelViscous[0];
  return (
    <div className="breakdown">
      <div className="section-title">
        Where the drag comes from
        <span className="muted">body {pct(body, total)} · wheels {pct(wheels, total)}</span>
      </div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group + r.label}>
              <th scope="row">{r.group} <span className="muted">{r.label.toLowerCase()}</span></th>
              <td className="bar-cell">
                <span className={`bar ${r.v < 0 ? "neg" : ""}`} style={{ width: `${(Math.abs(r.v) / max) * 100}%` }} />
              </td>
              <td className="num">{fmtInt(r.v)} N</td>
              <td className="num muted">{pct(r.v, total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResultsPanel() {
  const run = useStore(app, (s) => s.run);
  const runs = useStore(app, (s) => s.runs);
  const design = useStore(app, (s) => s.design);
  const [compareWith, setCompareWith] = useState("");
  if (!run) return null;
  const { doc } = run;
  const r = doc.result;
  const L = doc.geometry.dimensions[0];
  const passTime = L / r.freestream;
  const preset = resolvePreset(doc.settings);
  // Extended runs average over the last 30 % of the full (extended) length.
  const avgFrom = (preset.passes + (r.extendedPasses ?? 0)) * passTime * (1 - preset.averageFraction);
  const [x0, x1, y0, y1, , z1] = r.domain;
  const others = runs.filter((x) => x.id !== doc.id);

  return (
    <div className="results">
      <div className="results-head">
        <div className="results-eyebrow">
          <span className="eyebrow">Result · {fmtDate(doc.createdAt)}</span>
          {r.settled ? (
            <span className="badge ok" title="Forces varied little over the averaging window"><CheckCircle2 size={13} /> Settled</span>
          ) : (
            <span className="badge warn" title="Forces were still changing"><TriangleAlert size={13} /> Provisional</span>
          )}
        </div>
        <h2 title={doc.designName}>{doc.designName}</h2>
        <p className="muted small">{conditionsLine(doc.settings)}</p>
        {groupsLine(doc.geometry) && <p className="small groups-line" data-testid="run-groups">Groups: {groupsLine(doc.geometry)}</p>}
      </div>

      <Headline run={run} />

      {r.warnings.length > 0 && (
        <ul className="issues">
          {r.warnings.map((w) => (
            <li key={w} className="issue warn"><TriangleAlert size={15} /> <span>{w}</span></li>
          ))}
        </ul>
      )}

      <Breakdown run={run} />

      {r.levels && r.meshSensitivity && (
        <div className="breakdown">
          <div className="section-title">
            Grid levels
            <span className="muted">reported values are the mean</span>
          </div>
          <table>
            <tbody>
              {r.levels.map((lv) => (
                <tr key={lv.label}>
                  <th scope="row">{lv.label.replace(/ \(.*\)$/, "")} <span className="muted">{fmtCells(lv.cells)}</span></th>
                  <td className="num">Cd {fmt(lv.cd, 3)}</td>
                  <td className="num muted">Cl {fmt(lv.cl, 3)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Difference</th>
                <td className="num">{r.meshSensitivity.dCd >= 0 ? "+" : ""}{fmt(r.meshSensitivity.dCd, 3)}</td>
                <td className="num muted">{r.meshSensitivity.dCl >= 0 ? "+" : ""}{fmt(r.meshSensitivity.dCl, 3)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">Force history <span className="muted">shaded: averaging window</span></div>
      <ForceChart history={r.history} passTime={passTime} averageFrom={avgFrom} height={150} />

      <dl className="meta">
        <div><dt>Cells</dt><dd>{fmtCells(r.cells)}</dd></div>
        <div><dt>Steps</dt><dd>{fmtInt(r.steps)}</dd></div>
        <div><dt>Simulated</dt><dd>{fmt(r.simulatedTime, 2)} s</dd></div>
        <div><dt>Wall time</dt><dd>{fmtDuration(r.wallSeconds)}</dd></div>
        <div><dt>Blockage</dt><dd>{fmt(r.blockage * 100, 1)} %</dd></div>
        <div className="wide"><dt>Tunnel box</dt><dd>{fmt(x1 - x0, 1)} × {fmt(y1 - y0, 1)} × {fmt(z1, 1)} m</dd></div>
        <div><dt>Ref. area</dt><dd>{fmt(doc.settings.reference_area, 2)} m²</dd></div>
        <div><dt>Density</dt><dd>{fmt(doc.settings.density, 3)}</dd></div>
        <div><dt>Ground</dt><dd>{doc.settings.moving_ground ? "moving" : "fixed"}</dd></div>
        <div><dt>Wheels</dt><dd>{doc.settings.wheels ? "rotating" : "fixed"}</dd></div>
        <div className="wide"><dt>GPU</dt><dd title={doc.adapter}>{doc.adapter || "–"}</dd></div>
      </dl>

      <div className="actions">
        <div className="row gap-s wrap">
          <button className="btn ghost sm" onClick={() => exportJSON(doc)}><FileJson size={15} /> JSON</button>
          <button className="btn ghost sm" onClick={() => exportCSV(doc)}><FileSpreadsheet size={15} /> CSV</button>
          <button className="btn ghost sm" onClick={() => stages.main && exportPNG(stages.main.screenshot(), `${doc.designName}-${doc.id}`)}><Image size={15} /> PNG</button>
        </div>
        {others.length > 0 && (
          <div className="row gap-s">
            <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} aria-label="Run to compare with">
              <option value="">Compare with…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>{o.designName}{groupsLine(o.geometry) ? ` · ${groupsLine(o.geometry)}` : ""} · {Math.round(o.settings.speed_kmh)} km/h · {fmtDate(o.createdAt)}</option>
              ))}
            </select>
            <button className="btn ghost sm" disabled={!compareWith} onClick={() => startCompare(doc.id, compareWith)}><Columns2 size={15} /> Compare</button>
          </div>
        )}
        <button
          className="btn ghost block"
          onClick={() => (design?.id === doc.designId ? app.set({ view: "setup", step: "conditions" }) : openDesign(doc.designId))}
        >
          <Pencil size={15} /> Change the setup and run again
        </button>
      </div>
    </div>
  );
}
