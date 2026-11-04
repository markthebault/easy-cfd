import { useState } from "react";
import { Download, Flag, RotateCcw, Save, X } from "lucide-react";
import { MAX_CONFIGURATIONS, persistConfigurations, restoreConfigurations, type Configuration } from "./configurations";
import type { ForceReport } from "./metrics";
import type { Scene } from "./scene";

const number = (v: number | null) => v == null ? "—" : v.toFixed(3);
const delta = (v: number, b: number) => `${v >= b ? "+" : "−"}${Math.abs(v - b).toFixed(3)}`;
export function SavedConfigurations({scene, report, baseline, onBaseline, onRestore}: {
  scene: Scene; report: ForceReport | null; baseline: {scene: Scene; report: ForceReport} | null;
  onBaseline: (scene: Scene, report: ForceReport) => void; onRestore: (scene: Scene) => void;
}) {
  const [configurations, setConfigurations] = useState<Configuration[]>(restoreConfigurations), [name, setName] = useState("");
  const canSave = report?.cd != null && report.cl != null && report.status !== "empty" && configurations.length < MAX_CONFIGURATIONS;
  function commit(next: Configuration[]) { setConfigurations(next); persistConfigurations(next); }
  function save() {
    if (!canSave || !report) return;
    commit([...configurations, {id: crypto.randomUUID(), name: name.trim() || `Configuration ${configurations.length + 1}`, savedAt: new Date().toISOString(), scene: structuredClone(scene), report: structuredClone(report)}]); setName("");
  }
  function exportData() {
    const rows = [["configuration", "mean_Cd_2D", "mean_Cl_2D", "measurement_status", "averaging_reference_lengths", "reference_length_m", "Cd_mean_drift", "Cl_mean_drift", "delta_Cd", "delta_Cl", "settings", "saved_at"], ...configurations.map(c => {
      const r = c.report, matched = !!baseline && baseline.report.key === r.key && baseline.report.status === "ready" && r.status === "ready";
      return [c.name, r.cd, r.cl, r.status, r.averagingTravel, r.referenceLength, r.cdDrift, r.clDrift, matched ? r.cd! - baseline!.report.cd! : "", matched ? r.cl! - baseline!.report.cl! : "", r.key, c.savedAt];
    })];
    const csv = rows.map(row => row.map(v => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"), url = URL.createObjectURL(new Blob([csv], {type:"text/csv"})), a = document.createElement("a");
    a.href = url; a.download = "easycfd-configurations.csv"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="flow-configurations" aria-label="Saved configurations">
    <div className="flow-configuration-save"><input aria-label="Configuration name" placeholder="Configuration name" maxLength={80} value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")save();}} /><button disabled={!canSave} onClick={save} title="Save this design and its current averages. Unfinished measurements are marked provisional."><Save size={12}/>Save configuration</button></div>
    {configurations.length >= MAX_CONFIGURATIONS && <p>Remove a saved design to make room for another.</p>}
    <details open={configurations.length > 0}><summary>Saved configurations <span>{configurations.length}</span></summary>
      {configurations.length > 0 ? <><div className="flow-configuration-export"><span>Design · saved force values</span><button aria-label="Export saved configurations CSV" title="Export saved configurations" onClick={exportData}><Download size={12}/></button></div>
        <table><thead><tr><th>Design</th><th>Cd</th><th>Cl</th></tr></thead><tbody>{configurations.map(c=>{
          const matched = !!baseline && baseline.report.key === c.report.key, settled = c.report.status === "ready", comparable = matched && settled && baseline!.report.status === "ready";
          return <tr key={c.id} data-testid="saved-configuration"><td colSpan={3}><div className="flow-configuration-row"><input aria-label={`Rename configuration ${c.name}`} key={`${c.id}:${c.name}`} maxLength={80} defaultValue={c.name} onBlur={e=>{const name=e.currentTarget.value.trim();if(name)commit(configurations.map(item=>item.id===c.id?{...item,name}:item));else e.currentTarget.value=c.name;}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();}}/><div><b>{number(c.report.cd)}</b>{comparable && <small>Δ {delta(c.report.cd!,baseline!.report.cd!)}</small>}</div><div><b>{number(c.report.cl)}</b>{comparable && <small>Δ {delta(c.report.cl!,baseline!.report.cl!)}</small>}</div></div>
            <small className={`flow-configuration-quality ${settled?"settled":""}`}>{settled?"Mean settled":"Provisional"} · {c.report.averagingTravel.toFixed(1)} reference lengths</small>
            {baseline && !matched && <small className="flow-configuration-note">Different settings · no delta</small>}
            <div className="flow-configuration-actions"><button aria-label={`Restore configuration ${c.name}`} onClick={()=>onRestore(structuredClone(c.scene))}><RotateCcw size={10}/>Restore</button><button aria-label={`Use ${c.name} as baseline`} disabled={!settled} onClick={()=>onBaseline(c.scene,c.report)} title="Use a settled saved measurement as the baseline"><Flag size={10}/>Baseline</button><button aria-label={`Delete configuration ${c.name}`} onClick={()=>commit(configurations.filter(item=>item.id!==c.id))}><X size={12}/></button></div>
          </td></tr>;
        })}</tbody></table><p>Saved values stay fixed. Restore a design to measure it again. Deltas require settled means with matching settings.</p></> : <p>Save a design to keep its geometry, drag and lift. Provisional averages remain labelled.</p>}
    </details>
  </section>;
}
