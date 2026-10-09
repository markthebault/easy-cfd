// OpenFOAM engine: runs the OpenFOAM app's backend (same origin, /api) from this UI and turns its
// results into the data the viewer uses (RunResult, VizField, per-vertex surface values).
// Nothing leaves this computer or the tailnet: the backend is the local EasyCFD server.

import { balanceAtAxles, momentOrigin } from "../solver/aero";
import { estimateTyreLoads } from "../solver/tyreLoads";
import { OPENFOAM_ENABLED, OPENFOAM_COMING_SOON } from "./features";
import type { Part } from "../geometry/model";
import { writeSTL } from "../geometry/stl";
import { vizBoxFor, vizGrid, type SurfaceSample, type VizField } from "../solver/extract";
import type { ForceSample, RunResult, Settings, Vec3 } from "../solver/types";

export interface ServerPreset {
  cell: number;
  surface: number;
  layers: number;
  max_cells: number;
  iterations: number;
  label: string;
}

export interface ServerInfo {
  ready: boolean;
  message: string;
  cpus?: number;
  memory_gb?: number;
  presets: Record<"fast" | "medium" | "precise", ServerPreset>;
  /** Median wall time of completed runs per quality on this server (s). */
  measured: Partial<Record<"fast" | "medium" | "precise", { seconds: number; runs: number }>>;
  measuredWithoutUnderfloor?: ServerInfo["measured"];
}

/** Minimal view of a server run record. */
export interface ServerRun {
  id: string;
  project_id: string;
  name: string;
  created: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | string;
  stage?: string;
  iteration?: number;
  error?: string;
  started?: string;
  finished?: string;
  mesh_preset?: Record<string, unknown>;
  pipeline_hash?: string;
  settings: Record<string, unknown> & { profile?: string; speed_kmh: number; yaw_deg: number; quality: string; reference_area: number; density: number };
  domain?: number[];
  geometry: { parts: ServerPart[]; bounds?: [Vec3, Vec3] };
  result?: Record<string, any>;
}

export interface ServerPart {
  id: string;
  name: string;
  role: "body" | "wheel";
  enabled?: boolean;
  bounds: [Vec3, Vec3];
  source?: number;
  wheel?: { radius: number; center: Vec3 } | null;
}

export class ServerError extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!OPENFOAM_ENABLED) throw new ServerError(OPENFOAM_COMING_SOON);
  let response: Response;
  try {
    response = await fetch("/api" + path, init);
  } catch {
    throw new ServerError("The OpenFOAM server is not reachable. Start it with `just run-openfoam`.");
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON */
    }
    throw new ServerError(detail);
  }
  const type = response.headers.get("content-type") ?? "";
  return (type.includes("json") ? response.json() : response.arrayBuffer()) as Promise<T>;
}

const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
}

/** The server's health and presets, or null when this page is not served by the OpenFOAM app. */
export async function probeServer(): Promise<ServerInfo | null> {
  if (!OPENFOAM_ENABLED) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const response = await fetch("/api/health", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    const health = await response.json();
    if (!health || typeof health.ready !== "boolean" || !health.presets) return null;
    const measured: ServerInfo["measured"] = {};
    const measuredWithoutUnderfloor: ServerInfo["measured"] = {};
    try {
      const runs = await api<ServerRun[]>("/runs");
      for (const underfloor of [true, false]) for (const q of ["fast", "medium", "precise"] as const) {
        const secs = runs
          .filter((r) => r.status === "completed" && r.settings.quality === q && !r.settings.import_test && !r.settings.flow_animation && !(r.settings.profile ?? "").startsWith("advanced") &&
            (!health.pipeline_hash || r.pipeline_hash === health.pipeline_hash) && (r.settings.refine_underfloor !== false) === underfloor &&
            (q !== "medium" || Object.entries(health.presets.medium).every(([key,value])=>r.mesh_preset?.[key] === value)) && r.started && r.finished)
          .map((r) => (Date.parse(r.finished!) - Date.parse(r.started!)) / 1000)
          .filter((x) => x > 0);
        if (secs.length) (underfloor ? measured : measuredWithoutUnderfloor)[q] = { seconds: median(secs), runs: secs.length };
      }
    } catch {
      /* no run list: estimates stay generic */
    }
    return { ready: health.ready, message: health.message ?? "", cpus: health.cpus, memory_gb: health.memory_gb, presets: health.presets, measured, measuredWithoutUnderfloor };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure mappings (unit tested)
// ---------------------------------------------------------------------------------------------

/** The server's settings for a UI design. Custom quality has no OpenFOAM equivalent: Medium. */
export function serverSettings(s: Settings): Record<string, unknown> {
  const quality = s.import_test ? "fast" : s.quality === "custom" ? "medium" : s.quality;
  const b = s.simulation_box;
  const medium = quality === "medium" && (!s.profile || s.profile === "regular") && !(s.flow_animation && s.flow_detail === "fine");
  return {
    ...(s.import_test ? { import_test:true, profile:null } : s.flow_animation && s.flow_detail === "fine" ? {profile:null} : s.profile ? {profile:s.profile} : {}),
    ...(s.refine_groups ? {refine_groups:s.refine_groups}:{}),
    ...(s.refine_underfloor !== undefined ? {refine_underfloor:s.refine_underfloor}:{}),
    ...(s.axles?.confirmed ? { axles: s.axles } : {}),
    ...(s.max_seconds ? { max_seconds: medium ? Math.min(1200,s.max_seconds) : s.max_seconds } : {}),
    ...(s.vehicle_mass_kg !== undefined ? {vehicle_mass_kg:s.vehicle_mass_kg} : {}),
    ...(s.front_weight_percent !== undefined ? {front_weight_percent:s.front_weight_percent} : {}),
    speed_kmh: s.speed_kmh,
    yaw_deg: s.yaw_deg,
    quality,
    simulation_box: b ? { x_min: b.x_min, x_max: b.x_max, y_min: b.y_min, y_max: b.y_max, z_max: b.z_max } : null,
    custom_mesh: "medium",
    custom_iterations: 1000,
    reference_area: s.reference_area,
    density: s.density,
    moving_ground: s.moving_ground,
    wheels: s.wheels,
    flow_animation: !!s.flow_animation,
    ...(s.flow_detail !== undefined ? {flow_detail:s.flow_detail} : {}),
    geometry_confirmed: false,
  };
}

/** Translation from the UI frame to the server frame, from the same part's bounds in both. */
export function frameOffset(uiLow: Vec3, serverLow: Vec3): Vec3 {
  return [serverLow[0] - uiLow[0], serverLow[1] - uiLow[1], serverLow[2] - uiLow[2]];
}

export function soupLow(positions: Float32Array): Vec3 {
  const low: Vec3 = [Infinity, Infinity, Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let c = 0; c < 3; c++) low[c] = Math.min(low[c], positions[i + c]);
  return low;
}

/** A server tunnel domain [x0, x1, y0, y1, z0, z1] in the UI frame. */
export function domainToUi(d: number[], offset: Vec3): number[] {
  return [d[0] - offset[0], d[1] - offset[0], d[2] - offset[1], d[3] - offset[1], d[4] - offset[2], d[5] - offset[2]];
}

/** Iterations are the x axis of OpenFOAM histories: `time` holds the iteration (one unit each). */
export const OPENFOAM_ITERATIONS_PER_UNIT = 1;

export function historyFromServer(rows: { iteration: number; cd: number; cl: number }[]): ForceSample[] {
  return rows.map((h) => ({ time: h.iteration, step: h.iteration, cd: h.cd, cl: h.cl, cs: 0 }));
}

/** A server run record as the UI's run result (`domain`: fallback tunnel in the UI frame). */
export function resultFromRecord(run: ServerRun, carLength: number, offset: Vec3, domain: number[]): RunResult {
  const r = run.result!;
  const U = r.freestream ?? (run.settings.speed_kmh / 3.6 / Math.cos(run.settings.yaw_deg*Math.PI/180));
  const q = 0.5 * run.settings.density * U * U;
  const b = (r.breakdown ?? {}) as Record<string, Record<string, number>>;
  const role = (k: "body" | "wheels") => b[k] ?? { pressure_drag: 0, viscous_drag: 0, pressure_downforce: 0, viscous_downforce: 0 };
  const body = role("body"), wheels = role("wheels");
  const seconds = run.started && run.finished ? (Date.parse(run.finished) - Date.parse(run.started)) / 1000 : 0;
  const iterations = Number(r.iteration ?? run.iteration ?? 0);
  const balance = r.aero ? balanceAtAxles(r.aero,run.settings.axles as Settings["axles"],q*run.settings.reference_area) : undefined;
  const levels: RunResult["levels"] = r.refinement_levels?.map((level:any) => ({
    label: level.preset, cells: level.cells, cd: level.cd, cl: level.cl,
    drag: level.drag, lift: -level.downforce,
    aero: level.aero ? {...level.aero, origin: level.aero.origin.map((v:number,i:number) => v-offset[i])} : undefined,
    balance: level.aero ? balanceAtAxles(level.aero, run.settings.axles as Settings["axles"], q*run.settings.reference_area) : undefined,
  }));
  const spread = (values: (number | undefined)[]) => values.every(v => v !== undefined && Number.isFinite(v))
    ? Math.max(...values as number[]) - Math.min(...values as number[]) : undefined;
  return {
    cd: r.cd,
    cl: r.cl,
    aero: r.aero ? { ...r.aero, origin: r.aero.origin.map((v:number,i:number)=>v-offset[i]) } : undefined,
    balance,
    tyreLoads: estimateTyreLoads(balance, {vehicle_mass_kg: (run.settings.vehicle_mass_kg ?? undefined) as number | undefined, front_weight_percent: (run.settings.front_weight_percent ?? undefined) as number | undefined}),
    partForces: r.part_forces,
    levels,
    meshSensitivity: levels && levels.length >= 2 ? {
      dCd: spread(levels.map(l => l.cd))!, dCl: spread(levels.map(l => l.cl))!,
      frontLift: spread(levels.map(l => l.balance?.frontLift)),
      rearLift: spread(levels.map(l => l.balance?.rearLift)),
      pitch: spread(levels.map(l => l.aero?.moment[1])),
    } : undefined,
    reconciliation: r.reconciliation,
    provenance: r.provenance ? { ...r.provenance, origin: r.provenance.origin.map((v:number,i:number)=>v-offset[i]) } : undefined,
    cs: r.aero ? r.aero.force[1]/(q*run.settings.reference_area) : 0,
    drag: r.drag,
    lift: -r.downforce,
    side: r.aero?.force[1] ?? 0,
    downforce: r.downforce,
    breakdown: {
      bodyPressure: [body.pressure_drag, 0, -body.pressure_downforce],
      bodyViscous: [body.viscous_drag, 0, -body.viscous_downforce],
      wheelPressure: [wheels.pressure_drag, 0, -wheels.pressure_downforce],
      wheelViscous: [wheels.viscous_drag, 0, -wheels.viscous_downforce],
    },
    history: (r.history ?? []).map((h:any)=> {
      const loads=h.force && h.moment && r.aero ? balanceAtAxles({force:h.force,moment:h.moment,origin:r.aero.origin} as typeof r.aero,run.settings.axles as Settings["axles"],q*run.settings.reference_area) : undefined;
      return {time:h.iteration,step:h.iteration,cd:h.cd,cl:h.cl,cs:h.force ? h.force[1]/(q*run.settings.reference_area):0,...(h.moment ? {pitch:loads?.pitch ?? h.moment[1]} : {}),...(loads ? {frontLift:loads.frontLift,rearLift:loads.rearLift} : {})};
    }),
    balanceBands: r.balance_bands,
    settled: !!r.force_settled,
    cdSpan: r.cd_span ?? 0,
    clSpan: r.cl_span ?? 0,
    cdBand: r.cd_span === undefined ? undefined : r.cd_span / 2,
    clBand: r.cl_span === undefined ? undefined : r.cl_span / 2,
    cells: r.cells ?? 0,
    steps: iterations,
    simulatedTime: iterations,
    wallSeconds: seconds,
    freestream: U,
    dynamicPressure: q,
    domain: (run.domain ? domainToUi(run.domain, offset) : domain) as RunResult["domain"],
    blockage: r.blockage_ratio ?? 0,
    warnings: r.warnings ?? [],
    length: carLength,
    gridId: `openfoam:${run.id}`,
    engine: "openfoam",
    openfoam: {
      run: run.id,
      project: run.project_id,
      iterations,
      averagingIterations: r.averaging_iterations ?? 50,
      residuals: r.residuals ?? {},
      residualConverged: !!r.residual_converged,
      meshOk: r.mesh_ok,
      layerCoverage: r.layer_coverage,
      wallTargetFraction: r.wall_target_fraction,
      offset,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Server projects for UI designs
// ---------------------------------------------------------------------------------------------

const PROJECTS_KEY = "easycfd.openfoamProjects.coordinates-v2";
const MAX_FILES = 20;
const MAX_BYTES = 90 * 1024 * 1024;

interface ProjectLink {
  project: string;
  /** Server part id per UI part key. */
  parts: Record<string, string>;
  offset: Vec3;
  labels?: Record<string,Record<string,string>>;
}

function links(): Record<string, ProjectLink> {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

async function fingerprint(parts: { key: string; part: Part }[]): Promise<string> {
  const summary = parts.map(({ key, part: p }) => {
    const a = p.positions;
    return [key, a.length, a[0], a[1], a[2], a[a.length - 1], p.role, p.wheel?.radius ?? 0];
  });
  const bytes = new TextEncoder().encode(JSON.stringify(summary));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "part";

/**
 * The server project holding these parts (in the UI frame), created and uploaded when needed and
 * reused while the geometry is unchanged. Wheels get their role and radius.
 */
export async function ensureProject(name: string, parts: { key: string; part: Part }[], onStage: (s: string) => void): Promise<ProjectLink> {
  const fp = await fingerprint(parts);
  const known = links()[fp];
  if (known) {
    try {
      const p = await api<{ geometry?: { parts: ServerPart[] } }>(`/projects/${known.project}`);
      const ids = new Set((p.geometry?.parts ?? []).map((q) => q.id));
      if (Object.values(known.parts).every((id) => ids.has(id))) return {...known,labels:Object.fromEntries(parts.map(({key,part})=>[known.parts[key],{id:key,name:part.name,...(part.group?{group:part.group}:{})}]))};
    } catch {
      /* gone: upload again */
    }
  }
  onStage("Uploading the car to the OpenFOAM server");
  const project = await api<{ id: string }>("/projects", json({ name: `${name} · from EasyCFD Web`.slice(0, 100), sample: false }));
  // Batch only for request size limits; every part stays in the browser's shared frame.
  const files = parts.map(({ key, part }, i) => ({ key, part, name: `${String(i).padStart(2, "0")}-${safeName(part.name)}.stl`, bytes: writeSTL(part.positions, "EasyCFD Web part") }));
  const batches: (typeof files)[] = [];
  for (const f of files) {
    const cur = batches[batches.length - 1];
    if (cur && cur.length < MAX_FILES && cur.reduce((n, x) => n + x.bytes.byteLength, 0) + f.bytes.byteLength <= MAX_BYTES) cur.push(f);
    else batches.push([f]);
  }
  const clearance = Math.min(...parts.map(({ part }) => soupLow(part.positions)[2]));
  let record: { geometry: { parts: ServerPart[]; errors?: string[] } } | null = null;
  for (let b = 0; b < batches.length; b++) {
    const form = new FormData();
    for (const f of batches[b]) form.append("files", new Blob([f.bytes], { type: "model/stl" }), f.name);
    if (b === 0) form.append("options", JSON.stringify({ components: "group", units: "m", forward: "-X", up: "+Z", clearance, preserve_coordinates: true }));
    record = await api(`/projects/${project.id}/${b === 0 ? "import" : "parts"}`, { method: "POST", body: form });
  }
  const serverParts = record!.geometry.parts;
  if (serverParts.length !== files.length) throw new ServerError(`The server read ${serverParts.length} parts from ${files.length} files.`);
  // Server parts follow the upload order (one part per file with components grouped).
  const order = [...serverParts].sort((a, b) => (a.source ?? 0) - (b.source ?? 0));
  const offset = frameOffset(soupLow(files[0].part.positions), order[0].bounds[0]);
  const map: Record<string, string> = {};
  for (let i = 0; i < files.length; i++) {
    const { key, part } = files[i];
    const sp = order[i];
    map[key] = sp.id;
    if (part.role === "wheel" && part.wheel) {
      const c = part.wheel.center;
      await api(`/projects/${project.id}/parts/${sp.id}`, json({ role: "wheel", radius: part.wheel.radius, center: [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]] }, "PUT"));
    }
  }
  const labels = Object.fromEntries(files.map(f=>[map[f.key],{id:f.key,name:f.part.name,...(f.part.group ? {group:f.part.group}: {})}]));
  const link: ProjectLink = { project: project.id, parts: map, offset, labels };
  localStorage.setItem(PROJECTS_KEY, JSON.stringify({ ...links(), [fp]: link }));
  return link;
}

/** Concatenate existing surfaces without welding, filling, moving or remeshing. */
export function originalSurfaceAssembly(parts: Part[]): Part {
  const chosen = parts.filter(p => p.enabled);
  if (!chosen.length) throw new ServerError("Switch at least one part on.");
  const positions = new Float32Array(chosen.reduce((n,p)=>n+p.positions.length,0));
  let offset=0;
  for (const p of chosen) {positions.set(p.positions,offset);offset+=p.positions.length;}
  return {...chosen[0],id:"original-surface-assembly",name:"Original surfaces",file:"original-surfaces.stl",positions,role:"body",wheel:null,group:"g:body",enabled:true};
}

/** A quick assembly check avoids a separate mandatory mesh patch per fragment. */
export async function ensureOriginalSurfaceProject(name: string, parts: Part[], onStage: (s: string) => void): Promise<ProjectLink> {
  const assembly=originalSurfaceAssembly(parts);
  const link=await ensureProject(name,[{key:assembly.id,part:assembly}],onStage);
  const patch=link.parts[assembly.id];
  return {...link,parts:Object.fromEntries(parts.filter(p=>p.enabled).map(p=>[`${p.file}::${p.name}`,patch])),labels:{[patch]:{id:assembly.id,name:assembly.name,group:"g:body"}}};
}

/** Switch the simulated parts on, set the conditions and queue the run. */
export async function queueRun(link: ProjectLink, activeKeys: string[], settings: Settings): Promise<ServerRun> {
  const all = Object.values(link.parts);
  const on = activeKeys.map((k) => link.parts[k]).filter(Boolean);
  if (!on.length) throw new ServerError("Switch at least one part on.");
  await api(`/projects/${link.project}/parts-enabled`, json({ part_ids: all, enabled: false }, "PUT"));
  await api(`/projects/${link.project}/parts-enabled`, json({ part_ids: on, enabled: true }, "PUT"));
  await api(`/projects/${link.project}/settings`, json({ ...serverSettings(settings), moment_origin: momentOrigin(settings.axles).map((v,i)=>v+link.offset[i]), part_labels: link.labels ?? {} }, "PUT"));
  return api<ServerRun>(`/projects/${link.project}/runs`, { method: "POST" });
}

export const getRun = (id: string) => api<ServerRun>(`/runs/${id}`);
export const listRuns = () => api<ServerRun[]>("/runs");
export const cancelServerRun = (id: string) => api(`/runs/${id}/cancel`, { method: "POST" });

export interface LiveReport {
  status: string;
  stage?: string;
  iteration: number;
  error?: string;
  history: { iteration: number; cd: number; cl: number }[];
  recording_time_seconds?: number;
  recording_duration_seconds?: number;
}

export const liveReport = (id: string, every: number) => api<LiveReport>(`/runs/${id}/live?every=${Math.max(1, Math.round(every))}`);

export const OPENFOAM_SAMPLING_VERSION = 3;

/** The finished flow on the viewer's grid (UI frame), sampled by the server in its own frame. */
export async function fetchField(run: ServerRun, carLow: Vec3, carHigh: Vec3, domain: number[], target: number, offset: Vec3, signal?: AbortSignal): Promise<VizField> {
  const L = carHigh[0] - carLow[0];
  const box = vizBoxFor(carLow, carHigh, domain, L);
  const { origin, spacing, dims } = vizGrid(box.low, box.high, target);
  const serverOrigin: Vec3 = [origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]];
  const buf = await api<ArrayBuffer>(`/runs/${run.id}/viz-field`, {...json({ origin: serverOrigin, spacing, dims }),signal});
  const n = dims[0] * dims[1] * dims[2];
  if (buf.byteLength !== 21 * n) throw new ServerError("The flow field from the server has an unexpected size.");
  const f = (i: number) => new Float32Array(buf, 4 * n * i, n);
  const valid = new Uint8Array(buf, 20 * n, n);
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = valid[i] ? 0 : 1;
  const U = run.settings.speed_kmh / 3.6;
  const yaw = (run.settings.yaw_deg * Math.PI) / 180;
  return {
    origin, spacing, dims,
    u: f(0).slice(), v: f(1).slice(), w: f(2).slice(), p: f(3).slice(), k: f(4).slice(), solid,
    freestream: Math.hypot(U,U*Math.tan(yaw)), inlet: [U, U * Math.tan(yaw), 0], length: L,
  };
}

/** Surface pressure coefficient and near-wall flow direction at each part's soup vertices. */
export async function fetchSurface(run: ServerRun, parts: Part[], offset: Vec3, patches: Record<string,string> = {}, signal?: AbortSignal): Promise<SurfaceSample[]> {
  const sharedPatch=parts.map(p=>patches[`${p.file}::${p.name}`]);
  if (parts.length > 1 && sharedPatch.every(p=>p && p===sharedPatch[0])) {
    // An assembly has one wall patch. Sample once, then split in the source
    // order instead of launching a native sampling process per OBJ fragment.
    const assembly=originalSurfaceAssembly(parts);
    const [sample]=await fetchSurface(run,[assembly],offset,{[`${assembly.file}::${assembly.name}`]:sharedPatch[0]},signal);
    let at=0;
    return parts.map(p=>{
      const end=at+p.positions.length/3;
      const value:SurfaceSample={cp:sample.cp.slice(at,end),shear:sample.shear.slice(3*at,3*end),...(sample.wallStress ? {wallStress:sample.wallStress.slice(3*at,3*end)}:{}),...(sample.stressValid ? {stressValid:sample.stressValid.slice(at,end)}:{}),...(sample.snapshot ? {snapshot:sample.snapshot}:{})};
      at=end;return value;
    });
  }
  if (run.result?.provenance?.version === "openfoam-wall-integrals-2") {
    const result: SurfaceSample[] = [];
    for(const p of parts) {
      const key=`${p.file}::${p.name}`;
      const patch=patches[key] ?? run.result.part_forces?.find((f:any)=>f.id===key)?.patch;
      if(!patch) { result.push({cp:new Float32Array(p.positions.length/3).fill(NaN),shear:new Float32Array(p.positions.length)}); continue; }
      const soup=p.positions.map((v,i)=>v+offset[i%3]);
      const buf=await api<ArrayBuffer>(`/runs/${run.id}/surface-samples?version=2&part_id=${encodeURIComponent(patch)}`,{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:soup,signal});
      const nv=p.positions.length/3, header=new Uint32Array(buf,0,4);
      if(buf.byteLength!==16+29*nv || header[0]!==0x53464345 || header[1]!==2 || header[2]!==nv) throw new ServerError("Invalid version 2 surface data.");
      result.push({cp:new Float32Array(buf,16,nv).slice(),shear:new Float32Array(buf,16+4*nv,3*nv).slice(),wallStress:new Float32Array(buf,16+16*nv,3*nv).slice(),stressValid:new Uint8Array(buf,16+28*nv,nv).slice(),snapshot:{iteration:header[3],grid:`openfoam:${run.id}`,unit:"Pa",dynamicPressure:.5*run.settings.density*(run.result?.freestream ?? (run.settings.speed_kmh/3.6/Math.cos(run.settings.yaw_deg*Math.PI/180)))**2}});
    }
    return result;
  }
  const total = parts.reduce((n, p) => n + p.positions.length, 0);
  const soup = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      soup[o++] = a[i] + offset[0];
      soup[o++] = a[i + 1] + offset[1];
      soup[o++] = a[i + 2] + offset[2];
    }
  }
  const buf = await api<ArrayBuffer>(`/runs/${run.id}/surface-samples`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: soup, signal });
  const nv = total / 3;
  if (buf.byteLength !== 16 * nv) throw new ServerError("The surface values from the server have an unexpected size.");
  const cp = new Float32Array(buf, 0, nv);
  const shear = new Float32Array(buf, 4 * nv, 3 * nv);
  const out: SurfaceSample[] = [];
  let v = 0;
  for (const p of parts) {
    const m = p.positions.length / 3;
    out.push({ cp: cp.slice(v, v + m), shear: shear.slice(3 * v, 3 * (v + m)) });
    v += m;
  }
  return out;
}

export async function runGeometry(run: ServerRun, partId: string): Promise<ArrayBuffer> {
  return api<ArrayBuffer>(`/runs/${run.id}/geometry/${partId}.stl`);
}

/** Fetch computed physical-time frames, keeping server/UI coordinates aligned. */
export async function fetchAnimation(run: ServerRun, offset: Vec3, signal?: AbortSignal, section?: string, onProgress?: (loaded:number,total:number)=>void): Promise<import("../solver/animation").FlowAnimation | undefined> {
  if (!run.result?.flow_animation) return undefined;
  const query = section ? `?section=${encodeURIComponent(section)}` : "";
  const m = await api<import("../solver/animation").FlowAnimation & { origin: Vec3; spacing: Vec3; dims: [number, number, number]; freestream: number; inlet: Vec3; length: number }>(`/runs/${run.id}/animation${query}`, { signal });
  const fine = m.version === 2;
  if ((!fine && m.version !== 1) || m.timeUnit !== "s" || m.frames.length < 2 || m.frames.length > (fine ? 195 : 50) || m.dims.length !== 3 || m.dims.some(d => !Number.isInteger(d) || d < (fine ? 1 : 2) || d > 2048) || m.dims.reduce((a,b)=>a*b,1) > 150000 || m.origin.some(v=>!Number.isFinite(v)) || m.spacing.some(v=>!Number.isFinite(v) || v<=0)) throw new ServerError("Invalid flow animation data.");
  const n = m.dims[0] * m.dims[1] * m.dims[2];
  if (n*m.frames.length > 30_000_000 || (fine && (m.dims.filter(d=>d===1).length!==1 || !m.sections?.some(p=>p.id===m.section)))) throw new ServerError("Invalid detailed recording.");
  const frames: import("../solver/animation").FlowAnimation["frames"] = new Array(m.frames.length);
  for (let i = 0; i < m.frames.length; i++) {
    const time = m.frames[i].time;
    if (!Number.isFinite(time) || (i > 0 && time <= m.frames[i-1].time)) throw new ServerError("Invalid flow animation timestamps.");
  }
  let next = 0, loaded = 0;
  // A small request pool avoids serial round trips without retaining extra planes.
  // Slots are filled by native frame index so completion order cannot reorder time.
  await Promise.all(Array.from({length:Math.min(4,frames.length)}, async () => {
    for (;;) {
      const i = next++;
      if (i >= frames.length) return;
      const buf = await api<ArrayBuffer>(`/runs/${run.id}/animation/${i}${query}`, { signal });
      if (buf.byteLength !== 21 * n) throw new ServerError("Invalid flow animation frame size.");
      const valid = new Uint8Array(buf, 20*n, n), solid = valid.map(v => v ? 0 : 1);
      const f = (c: number) => new Float32Array(buf, 4*n*c, n);
      frames[i] = {time:m.frames[i].time, field: { origin: m.origin.map((v,j)=>v-offset[j]) as Vec3, spacing:m.spacing, dims:m.dims,
        freestream:m.freestream, inlet:m.inlet, length:m.length, u:f(0), v:f(1), w:f(2), p:f(3), k:f(4), solid }};
      onProgress?.(++loaded,frames.length);
    }
  }));
  const sections = m.sections?.map(p=>({...p, origin:p.origin.map((v,j)=>v-offset[j]) as Vec3, position:p.position-offset[p.axis]}));
  return { version:m.version, engine:"openfoam", timeUnit:"s", model:m.model, frames,
    ...(fine ? {sections,section:m.section,server:{run:run.id,offset}} : {}) };
}
