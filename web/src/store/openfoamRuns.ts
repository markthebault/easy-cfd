// OpenFOAM engine runs: upload the design to the local OpenFOAM server, follow the run live, then
// fetch the flow field and surface values and save the run like a WebGPU run. Also opens runs that
// were made on the server (for example in the original UI).

import type { Part } from "../geometry/model";
import { parseSTL } from "../geometry/stl";
import {
  cancelServerRun,
  domainToUi,
  ensureProject,
  fetchField,
  fetchAnimation,
  fetchSurface,
  frameOffset,
  getRun,
  historyFromServer,
  liveReport,
  OPENFOAM_ITERATIONS_PER_UNIT,
  queueRun,
  resultFromRecord,
  runGeometry,
  soupLow,
  type ServerRun,
} from "../engine/openfoam";
import { domainFor } from "../solver/setup";
import { DEFAULT_SETTINGS, type Settings, type Vec3 } from "../solver/types";
import {
  app,
  newDesignDoc,
  partsBounds,
  refreshLists,
  toast,
  vizForCar,
  type LiveState,
} from "./app";
import { get, hasKey, newId, put, sha256 } from "./db";
import {
  applyGroups,
  buildDesignParts,
  partKey,
  rawFromSource,
  summarize,
} from "./geometry";
import { saveAndShow } from "./runs";
import { replaceCachedAnimation } from "./animationCache";
import { animationRanges } from "./ranges";
import type { FileRef, PartOverride, RunDoc } from "./types";

const FINAL_POINTS = 900_000;
export const OPENFOAM_ADAPTER = "OpenFOAM v2412 · local server";

type ActiveRun = {
  runId: string | null;
  cancelled: boolean;
  controller: AbortController;
  fetching: boolean;
};
let active: ActiveRun | null = null;

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
  return new Set(
    app
      .get()
      .runs.map((r) => r.result.openfoam?.run)
      .filter((x): x is string => !!x),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function patchLive(p: Partial<LiveState>) {
  app.set((s) => (s.live ? { live: { ...s.live, ...p } } : {}));
}

function checkSession(session: ActiveRun | null): asserts session is ActiveRun {
  if (!session || active !== session || session.cancelled) aborted();
}

function aborted(): never {
  throw new DOMException("Simulation cancelled", "AbortError");
}

export function cancelOpenFoamRun() {
  if (!active) return;
  if (active.fetching) {
    active.cancelled = true;
    active.controller.abort();
    return;
  }
  if (active.runId) {
    patchLive({ serverStage: "Stopping the server solver…" });
    cancelServerRun(active.runId).catch((e) => toast(String(e), "error"));
  } else active.cancelled = true;
}

/** Load one native section at a time; other planes do not consume browser memory. */
export async function selectRecordedSection(section: string) {
  const run = app.get().run, animation = run?.animation;
  if (!run || !animation?.server || animation.section === section) return;
  app.set({busy:"loading"});
  try {
    const record = await getRun(animation.server.run);
    const next = await fetchAnimation(record, animation.server.offset, undefined, section,
      (loaded,total)=>app.set({busy:`Loading recorded section (${loaded}/${total})`}));
    const plane = next?.sections?.find(p=>p.id===section);
    if (!next || !plane || app.get().run?.doc.id !== run.doc.id) return;
    app.set(s=>({run:{...s.run!,animation:next,animationRanges:animationRanges(next,run.doc.settings.density)},
      viz:{...s.viz,sliceAxis:plane.axis,slicePos:plane.position}}));
    const stored = await get("fields",run.doc.id);
    if (stored) await replaceCachedAnimation(stored,next);
    return plane;
  } catch(e) {
    toast(`This section could not be loaded from the local server: ${e instanceof Error ? e.message : String(e)}`,"error");
  } finally { app.set({busy:null}); }
}

/** Iteration budget of a server preset (Precise solves the Medium mesh first). */
function budget(quality: string): number {
  const presets = app.get().server.info?.presets;
  if (!presets) return 1000;
  const q = (quality === "custom" ? "medium" : quality) as
    | "fast"
    | "medium"
    | "precise";
  return (
    presets[q].iterations + (q === "precise" ? presets.medium.iterations : 0)
  );
}

/** Follow a queued server run until it ends; returns the final record. */
async function follow(
  runId: string,
  total: number,
  started: number,
): Promise<ServerRun> {
  const session = active;
  let done = 0; // iterations of finished tiers (Precise runs two)
  let lastTier = "";
  for (;;) {
    await sleep(1500);
    if (active !== session || session?.cancelled) aborted();
    let lv;
    try {
      lv = await liveReport(runId, 1);
    } catch {
      continue; // transient: keep polling
    }
    if (active !== session) aborted();
    const tier = (lv.stage ?? "").split(":")[0];
    if (lastTier && tier !== lastTier && lv.iteration < 5)
      done = total - budget(tier);
    lastTier = tier;
    const solving = /solving/i.test(lv.stage ?? "");
    const recording = /recording/i.test(lv.stage ?? "") && !!lv.recording_duration_seconds;
    const history = historyFromServer(lv.history);
    patchLive({
      serverStage:
        lv.status === "queued"
          ? "Waiting for the solver (another run is in the queue)"
          : lv.stage,
      iteration: lv.iteration,
      recordingTime: lv.recording_time_seconds,
      recordingDuration: lv.recording_duration_seconds,
      stage: recording ? "recording" : solving ? "solving" : "preparing",
      fraction: Math.min(1, recording
        ? (lv.recording_time_seconds ?? 0) / lv.recording_duration_seconds!
        : (done + (lv.iteration ?? 0)) / Math.max(1, total)),
      history,
      time: lv.iteration,
      targetTime: total,
      elapsed: (performance.now() - started) / 1000,
    });
    if (lv.status !== "queued" && lv.status !== "running") return getRun(runId);
  }
}

/** Fetch the field and surface of a completed server run and save it as a run of `designId`. */
async function finish(
  rec: ServerRun,
  design: {
    id: string;
    name: string;
    source: RunDoc["source"];
    importOptions: RunDoc["importOptions"];
    overrides: RunDoc["overrides"];
    groups?: RunDoc["groups"];
  },
  settings: Settings,
  enabled: Part[],
  geometry: RunDoc["geometry"],
  offset: Vec3,
  patches: Record<string, string> = {},
) {
  const session = active;
  checkSession(session);
  session.fetching = true;
  const signal = session.controller.signal;
  const { low, high } = partsBounds(enabled);
  const lowV = low as Vec3,
    highV = high as Vec3;
  const domain = rec.domain
    ? domainToUi(rec.domain, offset)
    : domainFor(settings, lowV, highV);
  patchLive({
    stage: "saving",
    serverStage: "Fetching the flow field from the server",
    fraction: 1,
  });
  const field = await fetchField(
    rec,
    lowV,
    highV,
    domain,
    FINAL_POINTS,
    offset,
    signal,
  );
  checkSession(session);
  patchLive({ serverStage: "Sampling the car surface" });
  const surface = await fetchSurface(rec, enabled, offset, patches, signal);
  checkSession(session);
  const result = resultFromRecord(rec, highV[0] - lowV[0], offset, domain);
  if (result.partForces)
    result.partForces = result.partForces.map((f) => {
      const part = enabled.find(
        (p) =>
          partKey(p) === f.id ||
          patches[partKey(p)] === (f as typeof f & { patch?: string }).patch,
      );
      return part
        ? { ...f, id: partKey(part), name: part.name, group: part.group }
        : f;
    });
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
  if (rec.result?.flow_animation) patchLive({serverStage:"Loading recorded airflow",fraction:0});
  const animation = await fetchAnimation(rec, offset, signal, undefined,
    (loaded,total)=>patchLive({serverStage:`Loading recorded airflow (${loaded}/${total})`,fraction:loaded/total}));
  checkSession(session);
  patchLive({serverStage:"Saving the result in this browser",fraction:1});
  await saveAndShow(doc, enabled, field, surface, animation, () => active === session && !session.cancelled);
}

export async function startOpenFoamRun() {
  const s = app.get();
  const design = s.design;
  if (!design || !s.report) return;
  if (!s.server.info) {
    toast(
      "The OpenFOAM server is not available. Start EasyCFD with `just run-openfoam` and open it from there.",
      "error",
    );
    return;
  }
  const settings: Settings = {
    ...design.settings,
    engine: "openfoam",
    quality:
      design.settings.quality === "custom" ? "medium" : design.settings.quality,
  };
  const enabled = s.parts.filter((p) => p.enabled);
  // Every part with its own switch on is uploaded once, so switching groups reuses the project.
  const shaping = s.parts.filter((p) => p.selfEnabled ?? p.enabled);
  const geometry = summarize(s.parts, s.report, s.groups);
  const { low, high } = partsBounds(s.parts);
  const total =
    settings.flow_animation && settings.flow_detail === "fine" ? 500 : settings.profile === "advanced2"
      ? 30000
      : settings.profile === "advanced1"
        ? 6000
        : budget(settings.quality);
  const started = performance.now();
  active?.controller.abort();
  const session: ActiveRun = active = {
    runId: null,
    cancelled: false,
    controller: new AbortController(),
    fetching: false,
  };
  app.set({
    view: "live",
    viz: vizForCar(s.viz, low, high),
    live: {
      engine: "openfoam",
      serverStage: "Preparing",
      iteration: 0,
      iterations: total,
      stage: "preparing",
      fraction: 0,
      time: 0,
      targetTime: total,
      passTime: OPENFOAM_ITERATIONS_PER_UNIT,
      steps: 0,
      elapsed: 0,
      cells: 0,
      history: [],
      field: null,
      ranges: null,
      parts: enabled,
      settings,
      designName: design.name,
      snapshots: 0,
      error: null,
    },
  });
  try {
    const link = await ensureProject(
      design.name,
      shaping.map((p) => ({ key: partKey(p), part: p })),
      (stage) => { if (active === session) patchLive({ serverStage: stage }); },
    );
    if (link.labels)
      for (const label of Object.values(link.labels)) {
        const group = s.groups.find((g) => g.id === label.group);
        if (group) label.groupName = group.name;
      }
    checkSession(session);
    patchLive({ serverStage: "Queuing the run" });
    const queued = await queueRun(link, enabled.map(partKey), settings);
    checkSession(session);
    session.runId = queued.id;
    rememberRun(queued.id, {
      designId: design.id,
      activeKeys: enabled.map(partKey),
      offset: link.offset,
      settings,
    });
    const rec = await follow(queued.id, total, started);
    checkSession(session);
    if (rec.status === "cancelled") aborted();
    if (rec.status !== "completed")
      throw new Error(rec.error || `The OpenFOAM run ${rec.status}.`);
    await finish(
      rec,
      design,
      settings,
      enabled,
      geometry,
      link.offset,
      link.parts,
    );
    rememberRun(queued.id, null);
  } catch (e) {
    if (active !== session) return;
    if (
      active?.cancelled ||
      (e instanceof DOMException && e.name === "AbortError")
    ) {
      app.set({ view: "setup", live: null, step: "run" });
      toast("Simulation cancelled.");
    } else patchLive({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (active === session) active = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Runs made on the server (e.g. in the original UI)
// ---------------------------------------------------------------------------------------------

function settingsFromServer(s: ServerRun["settings"]): Settings {
  const q =
    s.quality === "fast" || s.quality === "medium" || s.quality === "precise"
      ? s.quality
      : "medium";
  const box = s.simulation_box as Settings["simulation_box"] | undefined;
  return {
    ...DEFAULT_SETTINGS,
    flow_animation: !!s.flow_animation,
    flow_detail: s.flow_detail === "fine" ? "fine" : "standard",
    speed_kmh: s.speed_kmh,
    yaw_deg: s.yaw_deg,
    quality: q,
    axles: (s.axles ?? undefined) as Settings["axles"],
    vehicle_mass_kg: (s.vehicle_mass_kg ?? undefined) as number | undefined,
    front_weight_percent: (s.front_weight_percent ?? undefined) as number | undefined,
    profile: s.profile as Settings["profile"],
    refine_groups: s.refine_groups as Settings["refine_groups"],
    refine_underfloor: s.refine_underfloor as Settings["refine_underfloor"],
    max_seconds: s.max_seconds as Settings["max_seconds"],
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
  const session = active;
  const design = await get("designs", info.designId);
  checkSession(session);
  if (!design) return false;
  const raw = await rawFromSource(design.source);
  checkSession(session);
  const all = buildDesignParts(
    raw,
    design.importOptions,
    design.overrides,
    design.groups,
  );
  const keys = new Set(info.activeKeys);
  const enabled = all.filter((p) => keys.has(partKey(p)));
  if (enabled.length !== keys.size) return false;
  const shown = all.map((p) => ({ ...p, enabled: keys.has(partKey(p)) }));
  const b = partsBounds(enabled);
  const report = {
    dimensions: [
      b.high[0] - b.low[0],
      b.high[1] - b.low[1],
      b.high[2] - b.low[2],
    ] as Vec3,
    triangles: enabled.reduce((n, p) => n + p.positions.length / 9, 0),
    frontalArea: 0,
  };
  showFetching(rec, enabled, info.settings, design.name, b);
  await finish(
    rec,
    design,
    info.settings,
    enabled,
    summarize(
      shown,
      report,
      applyGroups(shown, design.overrides, design.groups).groups,
    ),
    info.offset,
  );
  rememberRun(rec.id, null);
  return true;
}

function showFetching(
  rec: ServerRun,
  parts: Part[],
  settings: Settings,
  designName: string,
  b: { low: number[]; high: number[] },
) {
  app.set((s) => ({
    busy: null,
    view: "live",
    viz: vizForCar(s.viz, b.low, b.high),
    live: {
      engine: "openfoam",
      serverStage: "Fetching the flow field from the server",
      iteration: rec.iteration ?? 0,
      iterations: rec.iteration ?? 0,
      stage: "saving",
      fraction: 1,
      time: 0,
      targetTime: 1,
      passTime: OPENFOAM_ITERATIONS_PER_UNIT,
      steps: 0,
      elapsed: 0,
      cells: 0,
      history: historyFromServer(rec.result?.history ?? []),
      field: null,
      ranges: null,
      parts,
      settings,
      designName,
      snapshots: 0,
      error: null,
    },
  }));
}

/** Reopen server progress, then import its completed geometry and results. */
export async function importServerRun(id: string) {
  if (active?.runId === id) {
    app.set({library:false,view:"live"});
    return;
  }
  active?.controller.abort();
  const session: ActiveRun = active = {
    runId: id,
    cancelled: false,
    controller: new AbortController(),
    fetching: true,
  };
  app.set({ busy: "Opening the OpenFOAM run…", library: false });
  try {
    let rec = await getRun(id);
    if (active !== session) aborted();
    if (rec.status === "queued" || rec.status === "running") {
      session.fetching = false;
      const settings = settingsFromServer(rec.settings);
      const total = settings.flow_animation && settings.flow_detail === "fine" ? 500
        : settings.profile === "advanced2" ? 30000 : settings.profile === "advanced1" ? 6000 : budget(settings.quality);
      const bounds = rec.geometry.bounds ?? [[-2,-1,0],[2,1,1.5]];
      const elapsed = Math.max(0,(Date.now()-Date.parse(rec.started ?? rec.created))/1000);
      showFetching(rec, [], settings, rec.name, {low:bounds[0],high:bounds[1]});
      patchLive({stage:/solving/i.test(rec.stage ?? "") ? "solving" : "preparing",
        serverStage:rec.status === "queued" ? "Waiting for the solver (another run is in the queue)" : rec.stage,
        iterations:total,iteration:rec.iteration ?? 0,fraction:Math.min(1,(rec.iteration ?? 0)/total),
        targetTime:total,time:rec.iteration ?? 0,elapsed});
      // Geometry is a saved run snapshot and can load while solver polling continues.
      const previewRecord = rec;
      void (async()=>{
        const parts: Part[] = [];
        for (const p of previewRecord.geometry.parts.filter(p=>p.enabled !== false)) {
          if (active !== session || session.cancelled) return;
          const positions = parseSTL(await runGeometry(previewRecord,p.id));
          parts.push({id:p.id,name:p.name,file:`${p.id}.stl`,role:p.role,enabled:true,positions,wheel:p.wheel ?? null,base:true});
        }
        if (active !== session || session.fetching || session.cancelled) return;
        patchLive({parts});
        const b = partsBounds(parts);
        app.set(s=>({viz:vizForCar(s.viz,b.low,b.high)}));
      })().catch(e=>{
        if (active === session && !session.fetching) toast(`Car preview could not be loaded: ${e instanceof Error ? e.message : String(e)}`,"error");
      });
      rec = await follow(id,total,performance.now()-elapsed*1000);
    }
    checkSession(session);
    if (rec.status === "cancelled") aborted();
    if (rec.status !== "completed") throw new Error(rec.error || `The OpenFOAM run ${rec.status}.`);
    session.fetching = true;
    const started = startedRuns()[id];
    if (started && (await reattach(rec, started))) return;
    const serverParts = rec.geometry.parts.filter((p) => p.enabled !== false);
    const refs: FileRef[] = [];
    const overrides: Record<string, PartOverride> = {};
    const patches: Record<string, string> = {};
    const labels = rec.settings.part_labels as
      | Record<string, { group?: string; groupName?: string }>
      | undefined;
    const groups = new Map<
      string,
      { id: string; name: string; enabled: boolean }
    >();
    for (const p of serverParts) {
      const bytes = await runGeometry(rec, p.id);
      checkSession(session);
      const hash = await sha256(bytes);
      const name = `${safe(p.id)}-${safe(p.name)}.stl`;
      if (!(await hasKey("files", hash)))
        await put("files", { hash, name, bytes });
      refs.push({ hash, name, base: true, size: bytes.byteLength });
      const key = partKey({ file: name, name: name.replace(/\.stl$/, "") });
      patches[key] = p.id;
      const group =
        labels?.[p.id]?.group ?? (p.role === "wheel" ? "g:wheels" : "g:body");
      groups.set(group, {
        id: group,
        name:
          labels?.[p.id]?.groupName ??
          (group === "g:wheels"
            ? "Wheels"
            : group === "g:body"
              ? "Body"
              : group),
        enabled: true,
      });
      overrides[key] = {
        role: p.role,
        group,
        ...(p.wheel ? { radius: p.wheel.radius } : {}),
      };
    }
    checkSession(session);
    const clearance = Math.max(
      0.005,
      Math.min(...serverParts.map((p) => p.bounds[0][2])),
    );
    const settings = settingsFromServer(rec.settings);
    const design = {
      ...newDesignDoc(
        `${rec.name} · OpenFOAM`,
        { kind: "files", files: refs },
        settings,
      ),
      importOptions: {
        units: "m" as const,
        forward: "-X" as const,
        up: "+Z" as const,
        clearance,
        split: false,
      },
      overrides,
      groups: [...groups.values()],
    };
    await put("designs", design);
    const raw = await rawFromSource(design.source);
    checkSession(session);
    const parts = buildDesignParts(
      raw,
      design.importOptions,
      design.overrides,
      design.groups,
    );
    const offset = frameOffset(
      soupLow(parts[0].positions),
      serverParts[0].bounds[0],
    );
    if (settings.axles) {
      settings.axles = {...settings.axles, frontX:settings.axles.frontX-offset[0], rearX:settings.axles.rearX-offset[0], centrelineY:settings.axles.centrelineY-offset[1]};
      design.settings = settings;
      await put("designs", design);
    }
    const report = {
      dimensions: [0, 0, 0] as Vec3,
      triangles: parts.reduce((n, p) => n + p.positions.length / 9, 0),
      frontalArea: 0,
    };
    const b = partsBounds(parts);
    report.dimensions = [
      b.high[0] - b.low[0],
      b.high[1] - b.low[1],
      b.high[2] - b.low[2],
    ];
    const geometry = summarize(
      parts,
      report,
      applyGroups(parts, design.overrides, design.groups).groups,
    );
    checkSession(session);
    showFetching(rec, parts, settings, design.name, b);
    await finish(rec, design, settings, parts, geometry, offset, patches);
    refreshLists();
  } catch (e) {
    if (active !== session) return;
    if (session.cancelled || (e instanceof DOMException && e.name === "AbortError")) {
      app.set({ busy: null, live: null, view: "setup", step: "run" });
      toast(session.fetching ? "Results download cancelled." : "Simulation cancelled.");
      return;
    }
    app.set({ busy: null });
    const cur = app.get().live;
    if (cur) patchLive({ error: e instanceof Error ? e.message : String(e) });
    else toast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    if (active === session) active = null;
  }
}
