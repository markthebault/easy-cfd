// Lightweight browser OpenFOAM and the unchanged native/remote server analysis levels.
import { Cpu, Play, Server, TriangleAlert, Zap } from "lucide-react";
import type { ServerInfo } from "../engine/openfoam";
import { OPENFOAM_ENABLED, OPENFOAM_COMING_SOON } from "../engine/features";
import { backendAvailable, getRemoteConnection } from "../engine/connection";
import { WASM_PRESETS, wasmPreset, type WasmQuality } from "../engine/wasmPresets";
import { OpenFoamConnection } from "./OpenFoamConnection";
import type { Settings } from "../solver/types";
import { useStore } from "../store/store";
import { app, setSettings } from "../store/app";
import { startRun } from "../store/runs";
import { weightInputError } from "../solver/tyreLoads";
import { Toggle } from "./controls";
import { boundaryLine, fmt, fmtCells, fmtDuration } from "./format";

export function RunStep() {
  const design=useStore(app,s=>s.design)!;
  const report=useStore(app,s=>s.report),confirmed=useStore(app,s=>s.confirmed);
  const server=useStore(app,s=>s.server),groups=useStore(app,s=>s.groups);
  const s=design.settings,openfoam=s.engine === "openfoam",serverReady=backendAvailable() && server.status === "ready";
  const blocked=!report || !!report.errors.length || !confirmed;
  const weightError=weightInputError(s),wasmReady=typeof WebAssembly !== "undefined" && typeof Worker !== "undefined";
  const browserPreset=wasmPreset(s.quality);
  const fineFlow=openfoam && !!s.flow_animation && s.flow_detail === "fine";
  const mediumLevel=openfoam && !fineFlow && (!s.profile || s.profile === "regular") && s.quality === "medium";
  const limitCeiling=!openfoam ? browserPreset.seconds : mediumLevel ? 1200 : fineFlow || s.profile === "advanced2" ? 43200 : s.profile === "advanced1" ? 10800 : s.flow_animation ? 600 : 300;
  const timeLimit=Math.min(s.max_seconds ?? limitCeiling,limitCeiling);
  return <div className="step-body">
    <div className="engine-grid" role="radiogroup" aria-label="Solver engine">
      <button role="radio" aria-checked={!openfoam} className={`engine-card ${!openfoam?"on":""}`} data-testid="engine-wasm"
        onClick={()=>setSettings({engine:"wasm",quality:"fast",profile:"basic",max_seconds:300,flow_animation:false,flow_detail:"standard"})}>
        <span className="q-label"><Zap size={15}/> OpenFOAM · Browser</span>
        <span className="q-blurb">On this device</span><span className="q-meta">Quick airflow · no server needed</span>
      </button>
      <button role="radio" aria-checked={openfoam} className={`engine-card ${openfoam?"on":""}`} disabled={!serverReady}
        aria-describedby={!serverReady?"openfoam-availability":undefined} data-testid="engine-openfoam"
        onClick={()=>setSettings({engine:"openfoam",profile:"regular",quality:"medium",max_seconds:1200,flow_detail:"standard"})}>
        <span className="q-label"><Server size={15}/> OpenFOAM · Server</span>
        <span className="q-blurb">{getRemoteConnection()?"On your remote server":OPENFOAM_ENABLED?"On your native server":"Connect your server"}</span>
        <span className="q-meta">Advanced analysis and recordings</span>
      </button>
    </div>
    {!serverReady && <p id="openfoam-availability" className="field-hint" data-testid="openfoam-availability">
      {!backendAvailable()?OPENFOAM_COMING_SOON:server.status === "checking"?"Connecting to the OpenFOAM server…":server.error || server.info?.message || "Connect a remote OpenFOAM server or start the native server with just run-openfoam."}
    </p>}
    <OpenFoamConnection/>
    {openfoam?<OpenFoamLevels settings={s}/>:<>
      <div className="quality-grid browser" role="radiogroup" aria-label="Quality">
        {(Object.keys(WASM_PRESETS) as WasmQuality[]).map(q=>{const p=WASM_PRESETS[q];return <button key={q} role="radio" aria-checked={s.quality === q}
          className={`quality-card ${s.quality === q?"on":""}`} data-testid={`wasm-quality-${q}`}
          onClick={()=>setSettings({quality:q,profile:q === "fast"?"basic":"regular",max_seconds:p.seconds})}>
          <span className="q-label">{p.label}</span><span className="q-blurb">{p.blurb}</span>
          <span className="q-meta">{p.iterations} iterations · up to {fmtCells(p.maxCells)} cells</span>
        </button>})}
      </div>
      <p className="field-hint">Computes the car mesh, pressure, velocity and forces in this browser. Detailed can take tens of minutes; use a connected server for advanced design comparisons.</p>
    </>}
    {openfoam && s.profile?.startsWith("advanced") && <div className="group">
      <span className="field-label">Local refinement</span>
      {groups.filter(g=>g.enabled).map(g=>{const selected=s.refine_groups ?? groups.filter(x=>x.enabled && x.id !== "g:body").map(x=>x.id);
        return <label className="row gap-s small" key={g.id}><input type="checkbox" checked={selected.includes(g.id)}
          onChange={e=>setSettings({refine_groups:e.target.checked?[...selected,g.id]:selected.filter(id=>id !== g.id)})}/>{g.name}</label>;})}
      <label className="row gap-s small"><input type="checkbox" checked={s.refine_underfloor !== false}
        onChange={e=>setSettings({refine_underfloor:e.target.checked})}/>Underfloor and road gap</label>
      <p className="field-hint">Selected surfaces receive extra local cells. The mesh must pass its cell ceiling and layer checks.</p>
    </div>}
    <details className="group run-time-settings"><summary>Time limit</summary>
      <label className="field-label" htmlFor="elapsed-limit">Whole-job time limit (seconds)</label>
      <input id="elapsed-limit" type="number" min="30" max={limitCeiling} value={timeLimit}
        onChange={e=>setSettings({max_seconds:Math.max(30,Math.min(limitCeiling,Number(e.target.value)))})}/>
      <p className="field-hint">Stop is available during preparation and solving. {openfoam?"":"Browser runs use one CPU worker and a bounded mesh."}</p>
    </details>
    {openfoam && <div className="group flow-record-option">
      <Toggle checked={!!s.flow_animation} onChange={flow_animation=>{
        if(flow_animation && s.flow_detail === "fine"){setSettings({flow_animation,profile:undefined,quality:"medium",max_seconds:43200});return;}
        const normalLimit=s.profile === "basic"?300:1200,standard=s.profile === "basic" || s.profile === "regular";
        const from=normalLimit*(s.profile === "basic" && s.flow_animation?2:1),to=normalLimit*(s.profile === "basic" && flow_animation?2:1);
        setSettings({flow_animation,...(standard && (!s.max_seconds || s.max_seconds === from || s.max_seconds>to)?{max_seconds:to}:{})});
      }}
        label="Record flow animation" hint="Watch the computed airflow and wake evolve after the run."/>
      {s.flow_animation && <><label className="field-label" htmlFor="flow-detail">Recording detail</label>
        <select id="flow-detail" value={s.flow_detail ?? "standard"} onChange={e=>{const flow_detail=e.target.value as "standard"|"fine";
          setSettings(flow_detail === "fine"?{flow_detail,profile:undefined,quality:"medium",max_seconds:43200}:{flow_detail,profile:"advanced1",quality:"medium",max_seconds:10800});}}>
          <option value="standard">Standard airflow</option><option value="fine">Detailed wake</option></select>
        <p className="field-hint">{fineFlow?"DDES detailed wake recording on the server.":"Records 48 physical-time airflow frames on the server."}</p></>}
      {s.flow_animation && <p className="field-hint">Whole-job limit including recording: {fmtDuration(timeLimit)}. Stop is available throughout the run.</p>}
    </div>}
    {fineFlow && <p className="field-hint">Detailed wake mesh · up to 2 million cells · 6 GiB. Fine cells surround the car and continue into its wake.</p>}
    {!openfoam && <p className="field-hint">Steady airflow, pressure views and animated particles are included. Recording a changing physical-time wake requires the server engine.</p>}
    {openfoam?<OpenFoamSummary quality={s.quality} info={server.info}/>:<div className={`gpu-line ${wasmReady?"ready":"unavailable"}`}>
      <Cpu size={15}/><span>{wasmReady?"OpenFOAM WebAssembly · runs locally in this tab":"WebAssembly and browser workers are required."}</span>
    </div>}
    {openfoam && <div className={`gpu-line ${serverReady?"ready":"unavailable"}`}>
      {serverReady?<><Server size={15}/><span>OpenFOAM server · {server.info?.cpus ?? "?"} CPUs · {fmt(server.info?.memory_gb ?? 0,1)} GB memory</span></>:<><TriangleAlert size={15}/><span>The OpenFOAM server is not ready.</span></>}
    </div>}
    {weightError && <p className="inline-error" role="alert">{weightError} Edit the weight inputs in Conditions.</p>}
    <button className="btn run block" disabled={blocked || !!weightError || (openfoam?!serverReady:!wasmReady)} onClick={()=>startRun()} data-testid="run">
      <Play size={20} fill="currentColor"/> {openfoam?"Run on OpenFOAM server":"Run browser OpenFOAM"}
    </button>
    <p className="small center" data-testid="run-boundaries">{boundaryLine(s)}</p>
    {blocked && <small className="field-hint center">Finish the car step and tick the check box first.</small>}
    {!blocked && <small className="field-hint center">{openfoam?"The run continues on the server if you close this tab; reopen it from the run list.":"Keep this tab open until the run finishes. Results are saved on this device."}</small>}
  </div>;
}

const OF_LEVELS = [
  {profile:"basic",quality:"fast",label:"Fast",blurb:"Check the setup",limit:300},
  {profile:"regular",quality:"medium",label:"Medium",blurb:"Compare designs",limit:1200},
  {profile:"advanced1",quality:"medium",label:"Precise",blurb:"Single fine mesh",limit:10800},
  {profile:"advanced2",quality:"medium",label:"Very Precise",blurb:"Compare three meshes",limit:43200},
] as const;

function OpenFoamLevels({settings:s}:{settings:Settings}) {
  const fine = !!s.flow_animation && s.flow_detail === "fine";
  const selected = s.profile ?? (s.quality === "fast" ? "basic" : s.quality === "precise" ? "advanced1" : "regular");
  return <div className="group">
    <span className="field-label">Analysis level</span>
    <div className="quality-grid of" role="radiogroup" aria-label="Analysis level">
      {OF_LEVELS.map(level => <button key={level.profile} role="radio" aria-checked={!fine && selected === level.profile}
        className={`quality-card ${!fine && selected === level.profile ? "on" : ""}`}
        onClick={()=>setSettings({profile:level.profile,quality:level.quality,flow_detail:"standard",max_seconds:level.limit * (level.profile === "basic" && s.flow_animation ? 2 : 1)})}>
        <span className="q-label">{level.label}</span>
        <span className="q-blurb">{level.blurb}</span>
        <span className="q-meta">Up to {level.limit >= 3600 ? `${level.limit / 3600} hours` : fmtDuration(level.limit * (level.profile === "basic" && s.flow_animation ? 2 : 1))}</span>
      </button>)}
    </div>
    {fine && <p className="field-hint">Detailed wake uses a separate recording budget. Choose a level above to return to standard airflow.</p>}
  </div>;
}

function OpenFoamSummary({
  quality,
  info,
}: {
  quality: string;
  info: ServerInfo | null;
}) {
  const q = (quality === "custom" ? "medium" : quality) as
    | "fast"
    | "medium"
    | "precise";
  const p = info?.presets[q];
  const m = info?.measured[q];
  return (
    <div className="run-summary">
      <div>
        <span className="run-big">
          {p ? `≤ ${fmtCells(p.max_cells)}` : "–"}
        </span>
        <span className="run-small">
          cells, snappyHexMesh
          {p?.layers ? ` with ${p.layers} prism layers` : ""}
        </span>
      </div>
      <div>
        <span className="run-big">
          {m ? `~${fmtDuration(m.seconds)}` : "–"}
        </span>
        <span className="run-small">
          {m
            ? `median of ${m.runs} run${m.runs > 1 ? "s" : ""} on this server`
            : "runtime depends on the car; the first run measures it"}
        </span>
      </div>
    </div>
  );
}
