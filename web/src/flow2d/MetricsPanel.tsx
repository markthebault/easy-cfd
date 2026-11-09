import { useState } from "react";
import { Download, Flag, RotateCcw, X } from "lucide-react";
import { enabledShapes, referenceLengthFor, sceneError, sceneGrid, simulationKey, type Scene } from "./scene";
import type { ForceReport } from "./metrics";
import { SavedConfigurations } from "./SavedConfigurations";

type Baseline = { schema: "flow2d-baseline-1"; scene: Scene; report: ForceReport };
const BASELINE_KEY = "easycfd.flow2d.baseline.v1";
function restoreBaseline(): Baseline | null {
  try { const b = JSON.parse(localStorage.getItem(BASELINE_KEY) ?? "null") as Baseline; if (b?.schema === "flow2d-baseline-1" && b.report?.status === "ready" && Number.isFinite(b.report.cd) && Number.isFinite(b.report.cl) && typeof b.report.key === "string" && Array.isArray(b.scene?.shapes) && !sceneError(b.scene)) return b; } catch { /* Optional browser storage. */ }
  return null;
}
const number = (value: number | null | undefined) => value == null ? "—" : Math.abs(value) < .0005 ? "0.000" : value.toFixed(3);
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}`;
export function MetricsPanel({ scene, report, mobile, playing, onReference, onRestore }: { scene: Scene; report: ForceReport | null; mobile: boolean; playing: boolean; onReference: (length: number) => void; onRestore: (scene: Scene) => void }) {
  const [baseline, setBaseline] = useState<Baseline | null>(restoreBaseline);
  const current = report?.signature === simulationKey(scene) ? report : null, count = enabledShapes(scene).length, reference = referenceLengthFor(scene);
  const shownCd = current?.cd ?? current?.instantaneousCd, shownCl = current?.cl ?? current?.instantaneousCl;
  const comparable = !!baseline && !!current && baseline.report.key === current.key, ready = current?.status === "ready", delta = comparable && ready;
  function setSavedBaseline(scene: Scene, report: ForceReport) { const b: Baseline = { schema: "flow2d-baseline-1", scene: structuredClone(scene), report: structuredClone(report) }; setBaseline(b); try { localStorage.setItem(BASELINE_KEY, JSON.stringify(b)); } catch { /* Optional storage. */ } }
  function save() { if (current && ready) setSavedBaseline(scene, current); }
  function clear() { setBaseline(null); try { localStorage.removeItem(BASELINE_KEY); } catch { /* Optional storage. */ } }
  function exportData() {
    if (!current?.history.length) return;
    const grid = sceneGrid(scene), names = enabledShapes(scene).map(s => s.name).join(" | "), rows = [["travel_in_reference_lengths", "mean_Cd_2D", "mean_Cl_2D", "reference_length_m", "box_length_m", "box_height_m", "enabled_shapes", "solver"], ...current.history.map(p => [p.travel, p.cd, p.cl, reference, grid.width, grid.height, names, current.backend ?? "lbm"])];
    const csv = rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], {type:"text/csv"})), a = document.createElement("a"); a.href = url; a.download = "easycfd-2d-forces.csv"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const phase = !current ? "Preparing measurement…" : current.status === "empty" ? "No enabled shapes" : current.status === "warming" ? `Warming up · ${Math.round(current.progress * 100)}%` : current.status === "sampling" ? `Collecting average · ${Math.round(current.progress * 100)}%` : current.status === "settling" ? "Mean still settling" : "Mean settled";
  const status = !playing && current?.status !== "empty" ? `Paused · ${phase.toLowerCase()}` : phase;
  const difference = (value: number | null | undefined, base: number | null, drag: boolean) => {
    if (value == null || base == null) return null; const d = value - base;
    return <small className={drag && d < -((current?.cdDrift ?? Infinity) + (baseline?.report.cdDrift ?? Infinity)) ? "less-drag" : ""}>Δ {signed(d)}{drag && Math.abs(base) > .001 ? ` (${d >= 0 ? "+" : ""}${(100*d/Math.abs(base)).toFixed(1)}%)` : ""}</small>;
  };
  return <details className="flow-metrics glass" open={!mobile}>
    <summary><span>2D SECTION DATA</span><b>Drag &amp; lift</b><small>{current?.cd != null ? `Cd ${number(current.cd)} · Cl ${number(current.cl)}` : "Compare your changes"}</small></summary>
    <div className="flow-metric-status" role="status">{status}<span>{count} enabled {count === 1 ? "shape" : "shapes"} · total</span></div>
    <div className="flow-metric-values"><div><span>Drag · Cd</span><strong data-testid="drag-coefficient">{number(shownCd)}</strong>{delta && difference(current?.cd, baseline!.report.cd, true)}</div><div><span>Lift · Cl</span><strong data-testid="lift-coefficient">{number(shownCl)}</strong>{delta && difference(current?.cl, baseline!.report.cl, false)}</div></div>
    <p className="flow-metric-direction">{shownCl != null && shownCl < -.0005 ? "↓ Negative lift = downforce" : "↑ Positive lift = upward force"}{shownCd != null && shownCl != null && shownCd > .0001 && <span>{shownCl! < 0 ? "Downforce" : "Lift"}/drag: {(Math.abs(shownCl!)/shownCd!).toFixed(2)}</span>}</p>
    {current?.status === "warming" && current.instantaneousCd !== undefined && <p className="flow-metric-variation">Instantaneous forces during warmup<span>Averages start after the startup transient.</span></p>}
    {current && current.cd !== null && current.status !== "empty" && <p className="flow-metric-variation">Mean over {current.averagingTravel.toFixed(1)} reference lengths<span>{current.cdDrift !== null ? `Mean drift: Cd ${number(current.cdDrift)} · Cl ${number(current.clDrift)}` : "Collecting enough flow for a stability check"}</span>{current.status !== "ready" && <span>Provisional · keep the simulation running</span>}</p>}
    {current && current.history.length > 1 && <ForceHistory report={current} />}
    <div className="flow-metric-actions"><button onClick={save} disabled={!ready} title="Save once the long-term force mean passes repeated drift checks"><Flag size={12} />{baseline ? "Replace baseline" : "Save baseline"}</button><button aria-label="Export force data CSV" title="Export averaged force history" disabled={!current?.history.length} onClick={exportData}><Download size={13} /></button></div>
    {baseline && <div className="flow-baseline"><div><b>Baseline</b><button aria-label="Clear force baseline" onClick={clear}><X size={12} /></button></div><span>Cd {number(baseline.report.cd)} · Cl {number(baseline.report.cl)}</span><small>{!current ? "Waiting for current measurement" : !comparable ? "Different box, reference or backend, or older averaging method. Remeasure a matching baseline." : !ready ? "Waiting for the mean to settle…" : current.signature === simulationKey(baseline.scene) ? "Same design · any delta is sampling drift" : "Matched settings · deltas shown above"}</small><button onClick={()=>onRestore(structuredClone(baseline.scene))}><RotateCcw size={11} />Restore baseline design</button></div>}
    <SavedConfigurations scene={scene} report={current} baseline={baseline} onBaseline={setSavedBaseline} onRestore={onRestore}/>
    <details className="flow-metric-settings"><summary>Reference &amp; method</summary><label>Fixed reference length<input key={reference} aria-label="Force reference length in metres" type="number" min="0.01" max="1000" step="0.01" defaultValue={reference} onBlur={e=>{const v=e.currentTarget.valueAsNumber;if(Number.isFinite(v)&&v>=.01&&v<=1000&&Math.abs(v-reference)>1e-8)onReference(v);else e.currentTarget.value=String(reference);}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();}} /><small>m</small></label><p>Keep this fixed when rotating shapes or adding parts. The reference is shared by lift and drag.</p><p>{current?.backend === "vvflow" ? "vvflow integrates hydrodynamic force on the enabled solid bodies; image bodies are excluded. Reynolds number is 40,000 based on the reference length. The ground is impermeable with tangential slip, without a road boundary layer." : "Boundary momentum includes pressure and viscous transfer on the exposed union of enabled shapes."} Startup discards at least one box transit and four reference lengths. Every subsequent solver step contributes to the cumulative mean.</p><p>A stability check needs at least ten flow blocks (at least twenty reference lengths). Growing windows compare early and late block means and recent drift. Cd uses the larger of 0.015 and 3% of its mean as the drift limit; Cl uses the larger of 0.025 and 3%. Both must pass three consecutive checks. The test can revert to still settling. This is a sampling diagnostic, not an error bound or physical validation.</p>{current?.cd != null && <p>Wake fluctuations: Cd RMS {number(current.cdVariation)} · Cl RMS {number(current.clVariation)}. These batch fluctuations can remain large even when a time average settles.</p>}<p>Exploratory 2D section coefficients, not full-car or finite-wing predictions. No grid-convergence or benchmark qualification is claimed.</p><a href={current?.backend === "vvflow" ? "https://github.com/vvflow/vvflow" : "https://pubmed.ncbi.nlm.nih.gov/22400698/"} target="_blank" rel="noreferrer">{current?.backend === "vvflow" ? "vvflow force method" : "Momentum-exchange method"}</a></details>
  </details>;
}
function ForceHistory({report}:{report:ForceReport}) {
  const points=report.history, lo=Math.min(0,...points.flatMap(p=>[p.cd,p.cl])), hi=Math.max(.01,...points.flatMap(p=>[p.cd,p.cl])), span=hi-lo||1, start=points[0].travel, duration=points.at(-1)!.travel-start||1;
  const path=(key:"cd"|"cl")=>points.map((p,i)=>`${i?"L":"M"}${(8+(p.travel-start)/duration*250).toFixed(1)},${(5+(hi-p[key])/span*54).toFixed(1)}`).join(" ");
  return <figure className="flow-force-history"><svg viewBox="0 0 266 68" role="img" aria-label="Averaged drag and lift history"><line x1="8" x2="258" y1={5+hi/span*54} y2={5+hi/span*54} className="zero"/><path d={path("cd")} className="drag"/><path d={path("cl")} className="lift"/></svg><figcaption><span>Cd <i /> Cl</span><span>Flow history →</span></figcaption></figure>;
}
