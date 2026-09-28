// OpenFOAM engine runs: upload the design to the local OpenFOAM server, follow the run live, then
// fetch the flow field and surface values and save the run like a WebGPU run. Also opens runs that
// were made on the server (for example in the original UI).

import type { Part } from "../geometry/model";
import {
  cancelServerRun, domainToUi, ensureProject, fetchField, fetchSurface, frameOffset, getRun, historyFromServer, liveReport,
  OPENFOAM_ITERATIONS_PER_UNIT, queueRun, resultFromRecord, runGeometry, soupLow, type ServerRun,
} from "../engine/openfoam";
import { domainFor } from "../solver/setup";
import { DEFAULT_SETTINGS, type Settings, type Vec3 } from "../solver/types";
import { app, newDesignDoc, partsBounds, refreshLists, toast, vizForCar, type LiveState } from "./app";
import { get, hasKey, newId, put, sha256 } from "./db";
import { buildDesignParts, partKey, rawFromSource, summarize } from "./geometry";
import { saveAndShow } from "./runs";
import type { FileRef, PartOverride, RunDoc } from "./types";

const FINAL_POINTS = 900_000;
export const OPENFOAM_ADAPTER = "OpenFOAM v2412 · local server";

let active: { runId: string | null; cancelled: boolean } | null = null;

const STARTED_KEY = "easycfd.openfoamRuns";

/** Server runs started from this browser: which design and parts they belong to. */
interface StartedRun {
  designId: string;
  activeKeys: string[];
  offset: Vec3;
  settings: Settings;
}

function startedRuns(): Record<string, StartedRun> {
  try {
    return JSON.parse(localStorage.getItem(STARTED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function rememberRun(id: string, info: StartedRun | null) {
  const all = startedRuns();
  if (info) all[id] = info;
  else delete all[id];
  localStorage.setItem(STARTED_KEY, JSON.stringify(all));
}

/** Server run ids already saved as runs in this browser. */
export function importedRunIds(): Set<string> {
  return new Set(app.get().runs.map((r) => r.result.openfoam?.run).filter((x): x is string => !!x));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function patchLive(p: Partial<LiveState>) {
  app.set((s) => (s.live ? { live: { ...s.live, ...p } } : {}));
}

function aborted(): never {
  throw new DOMException("Simulation cancelled", "AbortError");
}

export function cancelOpenFoamRun() {
  if (!active) return;
  active.cancelled = true;
  if (active.runId) cancelServerRun(active.runId).catch(() => {});
}

/** Iteration budget of a server preset (Precise solves the Medium mesh first). */
function budget(quality: string): number {
  const presets = app.get().server.info?.presets;
  if (!presets) return 1000;
  const q = (quality === "custom" ? "medium" : quality) as "fast" | "medium" | "precise";
  return presets[q].iterations + (q === "precise" ? presets.medium.iterations : 0);
}

/** Follow a queued server run until it ends; returns the final record. */
async function follow(runId: string, total: number, started: number): Promise<ServerRun> {
  let done = 0; // iterations of finished tiers (Precise runs two)
  let lastTier = "";
  for (;;) {
    await sleep(1500);
    if (active?.cancelled) aborted();
    let lv;
    try {
      lv = await liveReport(runId, 1);
    } catch {
      continue; // transient: keep polling
    }
    const tier = (lv.stage ?? "").split(":")[0];
    if (lastTier && tier !== lastTier && lv.iteration < 5) done = total - budget(tier);
    lastTier = tier;
    const solving = /solving/i.test(lv.stage ?? "");
    const history = historyFromServer(lv.history);
    patchLive({
      serverStage: lv.status === "queued" ? "Waiting for the solver (another run is in the queue)" : lv.stage,
      iteration: lv.iteration,
      stage: solving ? "solving" : "preparing",
      fraction: Math.min(1, (done + (lv.iteration ?? 0)) / Math.max(1, total)),
      history,
      time: lv.iteration,
      targetTime: total,
      elapsed: (performance.now() - started) / 1000,
    });
    if (lv.status !== "queued" && lv.status !== "running") return getRun(runId);
  }
}

/** Fetch the field and surface of a completed server run and save it as a run of `designId`. */
async function finish(rec: ServerRun, design: { id: string; name: string; source: RunDoc["source"]; importOptions: RunDoc["importOptions"]; overrides: RunDoc["overrides"]; groups?: RunDoc["groups"] }, settings: Settings, enabled: Part[], geometry: RunDoc["geometry"], offset: Vec3) {
  const { low, high } = partsBounds(enabled);
  const lowV = low as Vec3, highV = high as Vec3;
  const domain = rec.domain ? domainToUi(rec.domain, offset) : domainFor(settings, lowV, highV);
  patchLive({ stage: "saving", serverStage: "Fetching the flow field from the server", fraction: 1 });
  const field = await fetchField(rec, lowV, highV, domain, FINAL_POINTS, offset);
  patchLive({ serverStage: "Sampling the car surface" });
  const surface = await fetchSurface(rec, enabled, offset);
  const result = resultFromRecord(rec, highV[0] - lowV[0], offset, domain);
  const doc: RunDoc = {
    id: newId("r"),
    designId: design.id,
    designName: design.name,
    createdAt: rec.finished ? Date.parse(rec.finished) : Date.now(),
    settings: { ...settings, engine: "openfoam" },
    source: design.source,
    importOptions: design.importOptions,
    overrides: design.overrides,
    groups: design.groups,
    geometry,
    result,
    adapter: OPENFOAM_ADAPTER,
    hasField: true,
  };
  await saveAndShow(doc, enabled, field, surface);
}

export async function startOpenFoamRun() {
  const s = app.get();
  const design = s.design;
  if (!design || !s.report) return;
  if (!s.server.info) {
    toast("The OpenFOAM server is not available. Start EasyCFD with `just run-openfoam` and open it from there.", "error");
    return;
  }
  const settings: Settings = { ...design.settings, engine: "openfoam", quality: design.settings.quality === "custom" ? "medium" : design.settings.quality };
  const enabled = s.parts.filter((p) => p.enabled);
  // Every part with its own switch on is uploaded once, so switching groups reuses the project.
  const shaping = s.parts.filter((p) => p.selfEnabled ?? p.enabled);
  const geometry = summarize(s.parts, s.report, s.groups);
  const { low, high } = partsBounds(s.parts);
  const total = budget(settings.quality);
  const started = performance.now();
  active = { runId: null, cancelled: false };
  app.set({
    view: "live",
    viz: vizForCar(s.viz, low, high),
    live: {
      engine: "openfoam", serverStage: "Preparing", iteration: 0, iterations: total,
      stage: "preparing", fraction: 0, time: 0, targetTime: total, passTime: OPENFOAM_ITERATIONS_PER_UNIT, steps: 0, elapsed: 0, cells: 0, history: [],
      field: null, ranges: null, parts: enabled, settings, designName: design.name, snapshots: 0, error: null,
    },
  });
  try {
    const link = await ensureProject(design.name, shaping.map((p) => ({ key: partKey(p), part: p })), (stage) => patchLive({ serverStage: stage }));
    if (active.cancelled) aborted();
    patchLive({ serverStage: "Queuing the run" });
    const queued = await queueRun(link, enabled.map(partKey), settings);
    active.runId = queued.id;
    rememberRun(queued.id, { designId: design.id, activeKeys: enabled.map(partKey), offset: link.offset, settings });
    const rec = await follow(queued.id, total, started);
    if (rec.status === "cancelled") aborted();
    if (rec.status !== "completed") throw new Error(rec.error || `The OpenFOAM run ${rec.status}.`);
    await finish(rec, design, settings, enabled, geometry, link.offset);
    rememberRun(queued.id, null);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      app.set({ view: "setup", live: null, step: "run" });
      toast("Simulation cancelled. The server run was stopped.");
    } else patchLive({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    active = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Runs made on the server (e.g. in the original UI)
// ---------------------------------------------------------------------------------------------

function settingsFromServer(s: ServerRun["settings"]): Settings {
  const q = s.quality === "fast" || s.quality === "medium" || s.quality === "precise" ? s.quality : "medium";
  const box = s.simulation_box as Settings["simulation_box"] | undefined;
  return {
    ...DEFAULT_SETTINGS,
    speed_kmh: s.speed_kmh,
    yaw_deg: s.yaw_deg,
    quality: q,
    reference_area: s.reference_area,
    density: s.density,
    moving_ground: s.moving_ground !== false,
    wheels: s.wheels !== false,
    simulation_box: box ?? null,
    engine: "openfoam",
  };
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "part";

/** A run started from this browser, finished while the tab was closed: attach it to its design. */
async function reattach(rec: ServerRun, info: StartedRun): Promise<boolean> {
  const design = await get("designs", info.designId);
  if (!design) return false;
  const raw = await rawFromSource(design.source);
  const all = buildDesignParts(raw, design.importOptions, design.overrides, design.groups);
  const keys = new Set(info.activeKeys);
  const enabled = all.filter((p) => keys.has(partKey(p)));
  if (enabled.length !== keys.size) return false;
  const shown = all.map((p) => ({ ...p, enabled: keys.has(partKey(p)) }));
  const b = partsBounds(enabled);
  const report = { dimensions: [b.high[0] - b.low[0], b.high[1] - b.low[1], b.high[2] - b.low[2]] as Vec3, triangles: enabled.reduce((n, p) => n + p.positions.length / 9, 0), frontalArea: 0 };
  showFetching(rec, enabled, info.settings, design.name, b);
  await finish(rec, design, info.settings, enabled, summarize(shown, report), info.offset);
  rememberRun(rec.id, null);
  return true;
}

function showFetching(rec: ServerRun, parts: Part[], settings: Settings, designName: string, b: { low: number[]; high: number[] }) {
  app.set((s) => ({ busy: null, view: "live", viz: vizForCar(s.viz, b.low, b.high), live: {
    engine: "openfoam", serverStage: "Fetching the flow field from the server", iteration: rec.iteration ?? 0, iterations: rec.iteration ?? 0,
    stage: "saving", fraction: 1, time: 0, targetTime: 1, passTime: OPENFOAM_ITERATIONS_PER_UNIT, steps: 0, elapsed: 0, cells: 0,
    history: historyFromServer(rec.result?.history ?? []), field: null, ranges: null, parts, settings, designName, snapshots: 0, error: null,
  } }));
}

/** Open a completed server run: its geometry becomes a design, its results a saved run. */
export async function importServerRun(id: string) {
  app.set({ busy: "Opening the OpenFOAM run…", library: false });
  try {
    const rec = await getRun(id);
    if (rec.status !== "completed") throw new Error("Only completed OpenFOAM runs can be opened.");
    const started = startedRuns()[id];
    if (started && (await reattach(rec, started))) return;
    const serverParts = rec.geometry.parts.filter((p) => p.enabled !== false);
    const refs: FileRef[] = [];
    const overrides: Record<string, PartOverride> = {};
    for (const p of serverParts) {
      const bytes = await runGeometry(rec, p.id);
      const hash = await sha256(bytes);
      const name = `${safe(p.name)}.stl`;
      if (!(await hasKey("files", hash))) await put("files", { hash, name, bytes });
      refs.push({ hash, name, base: true, size: bytes.byteLength });
      overrides[partKey({ file: name, name: name.replace(/\.stl$/, "") })] = p.role === "wheel" && p.wheel ? { role: "wheel", radius: p.wheel.radius } : { role: "body" };
    }
    const clearance = Math.max(0.005, Math.min(...serverParts.map((p) => p.bounds[0][2])));
    const settings = settingsFromServer(rec.settings);
    const design = {
      ...newDesignDoc(`${rec.name} · OpenFOAM`, { kind: "files", files: refs }, settings),
      importOptions: { units: "m" as const, forward: "-X" as const, up: "+Z" as const, clearance, split: false },
      overrides,
    };
    await put("designs", design);
    const raw = await rawFromSource(design.source);
    const parts = buildDesignParts(raw, design.importOptions, design.overrides, design.groups);
    const offset = frameOffset(soupLow(parts[0].positions), serverParts[0].bounds[0]);
    const report = { dimensions: [0, 0, 0] as Vec3, triangles: parts.reduce((n, p) => n + p.positions.length / 9, 0), frontalArea: 0 };
    const b = partsBounds(parts);
    report.dimensions = [b.high[0] - b.low[0], b.high[1] - b.low[1], b.high[2] - b.low[2]];
    const geometry = summarize(parts, report);
    showFetching(rec, parts, settings, design.name, b);
    await finish(rec, design, settings, parts, geometry, offset);
    refreshLists();
  } catch (e) {
    app.set({ busy: null });
    const cur = app.get().live;
    if (cur) patchLive({ error: e instanceof Error ? e.message : String(e) });
    else toast(e instanceof Error ? e.message : String(e), "error");
  }
}
