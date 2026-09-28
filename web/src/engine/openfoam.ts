// OpenFOAM engine: runs the OpenFOAM app's backend (same origin, /api) from this UI and turns its
// results into the data the viewer uses (RunResult, VizField, per-vertex surface values).
// Nothing leaves this computer or the tailnet: the backend is the local EasyCFD server.

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
  settings: Record<string, unknown> & { speed_kmh: number; yaw_deg: number; quality: string; reference_area: number; density: number };
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const response = await fetch("/api/health", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    const health = await response.json();
    if (!health || typeof health.ready !== "boolean" || !health.presets) return null;
    const measured: ServerInfo["measured"] = {};
    try {
      const runs = await api<ServerRun[]>("/runs");
      for (const q of ["fast", "medium", "precise"] as const) {
        const secs = runs
          .filter((r) => r.status === "completed" && r.settings.quality === q && r.started && r.finished)
          .map((r) => (Date.parse(r.finished!) - Date.parse(r.started!)) / 1000)
          .filter((x) => x > 0);
        if (secs.length) measured[q] = { seconds: median(secs), runs: secs.length };
      }
    } catch {
      /* no run list: estimates stay generic */
    }
    return { ready: health.ready, message: health.message ?? "", cpus: health.cpus, memory_gb: health.memory_gb, presets: health.presets, measured };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure mappings (unit tested)
// ---------------------------------------------------------------------------------------------

/** The server's settings for a UI design. Custom quality has no OpenFOAM equivalent: Medium. */
export function serverSettings(s: Settings): Record<string, unknown> {
  const quality = s.quality === "custom" ? "medium" : s.quality;
  const b = s.simulation_box;
  return {
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
    geometry_confirmed: true,
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
  const U = run.settings.speed_kmh / 3.6;
  const q = 0.5 * run.settings.density * U * U;
  const b = (r.breakdown ?? {}) as Record<string, Record<string, number>>;
  const role = (k: "body" | "wheels") => b[k] ?? { pressure_drag: 0, viscous_drag: 0, pressure_downforce: 0, viscous_downforce: 0 };
  const body = role("body"), wheels = role("wheels");
  const seconds = run.started && run.finished ? (Date.parse(run.finished) - Date.parse(run.started)) / 1000 : 0;
  const iterations = Number(r.iteration ?? run.iteration ?? 0);
  return {
    cd: r.cd,
    cl: r.cl,
    cs: 0,
    drag: r.drag,
    lift: -r.downforce,
    side: 0,
    downforce: r.downforce,
    breakdown: {
      bodyPressure: [body.pressure_drag, 0, -body.pressure_downforce],
      bodyViscous: [body.viscous_drag, 0, -body.viscous_downforce],
      wheelPressure: [wheels.pressure_drag, 0, -wheels.pressure_downforce],
      wheelViscous: [wheels.viscous_drag, 0, -wheels.viscous_downforce],
    },
    history: historyFromServer(r.history ?? []),
    settled: !!r.force_settled,
    cdSpan: r.cd_span ?? 0,
    clSpan: r.cl_span ?? 0,
    cdBand: (r.cd_span ?? 0) / 2,
    clBand: (r.cl_span ?? 0) / 2,
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

const PROJECTS_KEY = "easycfd.openfoamProjects";
const MAX_FILES = 20;
const MAX_BYTES = 90 * 1024 * 1024;

interface ProjectLink {
  project: string;
  /** Server part id per UI part key. */
  parts: Record<string, string>;
  offset: Vec3;
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
      if (Object.values(known.parts).every((id) => ids.has(id))) return known;
    } catch {
      /* gone: upload again */
    }
  }
  onStage("Uploading the car to the OpenFOAM server");
  const project = await api<{ id: string }>("/projects", json({ name: `${name} · from EasyCFD Web`.slice(0, 100), sample: false }));
  // Batches within the server's per-request limits; the first defines the car's position.
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
    if (b === 0) form.append("options", JSON.stringify({ components: "group", units: "m", forward: "-X", up: "+Z", clearance: Math.round(Math.min(2, Math.max(0.005, clearance)) * 1e4) / 1e4 }));
    record = await api(`/projects/${project.id}/${b === 0 ? "import" : "parts"}`, { method: "POST", body: form });
  }
  const serverParts = record!.geometry.parts;
  if (record!.geometry.errors?.length) throw new ServerError(record!.geometry.errors.join(" "));
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
  const link: ProjectLink = { project: project.id, parts: map, offset };
  localStorage.setItem(PROJECTS_KEY, JSON.stringify({ ...links(), [fp]: link }));
  return link;
}

/** Switch the simulated parts on, set the conditions and queue the run. */
export async function queueRun(link: ProjectLink, activeKeys: string[], settings: Settings): Promise<ServerRun> {
  const all = Object.values(link.parts);
  const on = activeKeys.map((k) => link.parts[k]).filter(Boolean);
  if (!on.length) throw new ServerError("Switch at least one part on.");
  await api(`/projects/${link.project}/parts-enabled`, json({ part_ids: all, enabled: false }, "PUT"));
  await api(`/projects/${link.project}/parts-enabled`, json({ part_ids: on, enabled: true }, "PUT"));
  await api(`/projects/${link.project}/settings`, json(serverSettings(settings), "PUT"));
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
}

export const liveReport = (id: string, every: number) => api<LiveReport>(`/runs/${id}/live?every=${Math.max(1, Math.round(every))}`);

/** The finished flow on the viewer's grid (UI frame), sampled by the server in its own frame. */
export async function fetchField(run: ServerRun, carLow: Vec3, carHigh: Vec3, domain: number[], target: number, offset: Vec3): Promise<VizField> {
  const L = carHigh[0] - carLow[0];
  const box = vizBoxFor(carLow, carHigh, domain, L);
  const { origin, spacing, dims } = vizGrid(box.low, box.high, target);
  const serverOrigin: Vec3 = [origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]];
  const buf = await api<ArrayBuffer>(`/runs/${run.id}/viz-field`, json({ origin: serverOrigin, spacing, dims }));
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
    freestream: U, inlet: [U, U * Math.tan(yaw), 0], length: L,
  };
}

/** Surface pressure coefficient and near-wall flow direction at each part's soup vertices. */
export async function fetchSurface(run: ServerRun, parts: Part[], offset: Vec3): Promise<SurfaceSample[]> {
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
  const buf = await api<ArrayBuffer>(`/runs/${run.id}/surface-samples`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: soup });
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
