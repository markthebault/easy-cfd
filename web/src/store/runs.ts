import { computeLease } from "../engine/computeLease";
import { OPENFOAM_ENABLED, OPENFOAM_COMING_SOON } from "../engine/features";
import { fetchField, getRun, OPENFOAM_SAMPLING_VERSION } from "../engine/openfoam";
// Running simulations, saving them, reopening them and exporting them.

import { checkGeometry, type Part } from "../geometry/model";
import type { SurfaceSample, VizField } from "../solver/extract";
import { cancelOpenFoamRun, startOpenFoamRun } from "./openfoamRuns";
import { recordFlowAnimation, ANIMATION_POINTS, type FlowAnimation } from "../solver/animation";
import { runSimulation } from "../solver/run";
import { resolvePreset } from "../solver/types";
import type { VehicleWeight, Vec3 } from "../solver/types";
import { estimateTyreLoads, weightInputError } from "../solver/tyreLoads";
import { resolvedAxles } from "../solver/aero";
import { assessedResult, detectRunAxles } from "./axleAnalysis";
import { CaseWorker } from "../workers/caseClient";
import { app, gpuDevice, partsBounds, refreshLists, setSettings, toast, vizForCar, type LiveState } from "./app";
import { decodeField, decodeSurface, encodeField, encodeSurface } from "./codec";
import { cacheAnimation, restoreAnimation } from "./animationCache";
import { collectFiles, get, newId, put, remove, removeAnimationFrames, sha256 } from "./db";
import { recordRun } from "./estimate";
import { buildDesignParts, partKey, rawFromSource, summarize, toSolverParts, type RawPart } from "./geometry";
import { animationRanges, computeRanges, mergeRanges } from "./ranges";
import type { LoadedRun, RunDoc } from "./types";

const LIVE_POINTS = 260_000;
const FINAL_POINTS = 900_000;

let controller: AbortController | null = null;

function patchLive(p: Partial<LiveState>) {
  app.set((s) => (s.live ? { live: { ...s.live, ...p } } : {}));
}

/** Save a finished run (either engine) in the browser and show it. */
export async function saveAndShow(doc: RunDoc, enabled: Part[], field: VizField | null, surface: SurfaceSample[] | null, animation?: FlowAnimation, shouldShow: () => boolean = () => true) {
  doc = detectRunAxles(doc, enabled);
  const keys = enabled.map(partKey);
  try {
    if (field) {
      const recording = await cacheAnimation(doc.id,animation);
      await put("fields", { id: doc.id, field: encodeField(field), surface: encodeSurface(keys, surface ?? []), ...recording,
        ...(doc.result.openfoam ? {openfoamSamplingVersion: OPENFOAM_SAMPLING_VERSION} : {}) });
    }
    await put("runs", doc);
  } catch (e) {
    toast(`The result could not be saved in the browser (${e instanceof Error ? e.message : String(e)}). It is shown but will be lost on reload.`, "error");
  }
  refreshLists();
  if (!shouldShow()) return;
  const ranges = computeRanges(field, surface, doc.result.freestream, doc.settings.density);
  app.set({ view: "results", live: null, run: { doc, parts: enabled, field, surface, ranges, animation, animationRanges: animation ? animationRanges(animation, doc.settings.density) : undefined } });
}

/** Add a separately versioned weight assessment without changing the original CFD snapshot. */
export async function assessTyreLoads(patch: Partial<VehicleWeight>) {
  const run = app.get().run;
  if (!run) return;
  const previous = run.doc.tyreLoadAssessment?.inputs ?? run.doc.settings;
  const inputs = {vehicle_mass_kg: previous.vehicle_mass_kg, front_weight_percent: previous.front_weight_percent, ...patch};
  const doc: RunDoc = {...run.doc, tyreLoadAssessment: {version: "steady-axle-loads-1", assessedAt: Date.now(), inputs,
    loads: estimateTyreLoads(assessedResult(run.doc).balance, inputs)}};
  app.set({run: {...run, doc}});
  try {
    await put("runs", doc);
    await refreshLists();
  } catch {
    toast("The tyre load assessment could not be saved. It will be lost on reload.", "error");
  }
}

export async function startRun() {
  const s = app.get();
  let design = s.design;
  if (!design || !s.report) return;
  if (design.settings.engine === "openfoam") {
    if (!OPENFOAM_ENABLED) { toast(OPENFOAM_COMING_SOON, "error"); return; }
    return startOpenFoamRun();
  }
  const checked = checkGeometry(s.parts, design.source.kind === "files" && design.source.files.some(f => /\.stl$/i.test(f.name)));
  if (checked.errors.length || !s.confirmed) return;
  if (!design.settings.axles || design.settings.axles.source === "wheels") {
    const axles = resolvedAxles(design.settings.axles,toSolverParts(s.parts, s.groups));
    if (JSON.stringify(axles) !== JSON.stringify(design.settings.axles)) {
      setSettings({axles});
      design = {...design, settings:{...design.settings,axles}};
    }
  }
  const weightError = weightInputError(design.settings);
  if (weightError) { toast(weightError, "error"); return; }
  if (s.gpu.status === "unavailable" || s.gpu.status === "checking") {
    toast(s.gpu.message || "WebGPU is not ready yet.", "error");
    return;
  }
  const settings = { ...design.settings };
  const enabled = s.parts.filter((p) => p.enabled);
  const solverParts = toSolverParts(s.parts, s.groups);
  const geometry = summarize(s.parts, s.report, s.groups);
  const { low, high } = partsBounds(s.parts);
  controller = new AbortController();
  const signal = controller.signal;
  app.set({
    view: "live",
    viz: vizForCar(s.viz, low, high),
    live: {
      stage: "preparing", fraction: 0, time: 0, targetTime: 1, passTime: 1, steps: 0, elapsed: 0, cells: 0, history: [],
      field: null, ranges: null, parts: enabled, settings, designName: design.name, snapshots: 0, error: null,
    },
  });
  const worker = new CaseWorker();
  const started = performance.now();
  signal.addEventListener("abort",()=>worker.dispose(),{once:true});
  let releaseLease:(()=>Promise<void>)|undefined;
  try {
    releaseLease=await computeLease(signal,()=>controller?.abort(),s.server.status === "ready" || s.server.status === "busy");
    const { device, adapterName } = await gpuDevice();
    if (signal.aborted) throw new DOMException("Simulation cancelled", "AbortError");
    settings.gpu_buffer_limit=Math.min(device.limits.maxBufferSize,device.limits.maxStorageBufferBindingSize);
    const setup = await worker.prepare(solverParts, settings);
    patchLive({ passTime: setup.length / setup.freestream });
    if (signal.aborted) throw new DOMException("Simulation cancelled", "AbortError");
    let snapBusy = false;
    let lastUi = 0;
    let solveStart = 0;
    const { result, solver } = await runSimulation(device, solverParts, settings, {
      setup,
      deadline: started+1000*(settings.max_seconds ?? (settings.quality === "fast"?300:600)),
      prepareLevel: (lv) => worker.prepare(solverParts, lv),
      signal,
      snapshotSeconds: 2.5,
      onProgress: (p) => {
        if (p.stage === "solving" && !solveStart) solveStart = performance.now();
        const now = performance.now();
        if (now - lastUi < 120 && p.stage === "solving") return;
        lastUi = now;
        patchLive({
          stage: p.stage, fraction: p.fraction, time: p.time, targetTime: p.targetTime, steps: p.steps,
          elapsed: (now - started) / 1000, cells: p.cells, history: p.history.slice(),
        });
      },
      onSnapshot: async (live) => {
        if (snapBusy) return;
        snapBusy = true;
        const fields = await live.readFields();
        worker
          .extract(fields, live.c, LIVE_POINTS, false)
          .then(({ field }) => {
            const cur = app.get().live;
            if (!cur || signal.aborted) return;
            patchLive({ field, ranges: computeRanges(field, null, field.freestream, settings.density), snapshots: cur.snapshots + 1 });
          })
          .catch(() => {})
          .finally(() => (snapBusy = false));
      },
    });
    const solveSeconds = (performance.now() - (solveStart || started)) / 1000;
    patchLive({ stage: "saving", fraction: 1 });
    let animation: FlowAnimation | undefined;
    let field: VizField, surface: SurfaceSample[] | null;
    try {
      const fields = await solver.readFields(true);
      ({ field, surface } = await worker.extract(fields, solver.c, FINAL_POINTS, true));
      if (settings.flow_animation) {
        patchLive({ stage: "finishing", fraction: 0, serverStage: "Recording flow animation" });
        animation = await recordFlowAnimation(solver, async () => {
          const f = await solver.readFields();
          return (await worker.extract(f, solver.c, ANIMATION_POINTS, false)).field;
        }, { signal, deadline: started + 1000 * (settings.max_seconds ?? (settings.quality === "fast" ? 300 : 600)),
          onProgress: fraction => patchLive({ fraction, serverStage: "Recording flow animation" }) });
      }
    } finally { solver.destroy(); }

    const preset = resolvePreset(settings);
    if (!result.levels) recordRun(result.cells, result.steps, solveSeconds, preset.passes, preset.cellsPerLength * Math.sqrt(result.detail?.ratio ?? 1));
    const doc: RunDoc = {
      id: newId("r"),
      designId: design.id,
      designName: design.name,
      createdAt: Date.now(),
      settings,
      source: design.source,
      importOptions: design.importOptions,
      overrides: design.overrides,
      groups: design.groups,
      geometry,
      result,
      adapter: adapterName,
      hasField: true,
    };
    if(result.provenance)result.provenance.geometry=await sha256(new TextEncoder().encode(JSON.stringify([doc.source,doc.importOptions,doc.overrides,doc.geometry])).buffer);
    await saveAndShow(doc, enabled, field, surface, animation);
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
      app.set({ view: "setup", live: null, step: "run" });
      toast("Simulation cancelled.");
    } else patchLive({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    worker.dispose();
    await releaseLease?.();
    controller = null;
  }
}

export function cancelRun() {
  controller?.abort();
  cancelOpenFoamRun();
}

export function dismissLive() {
  app.set({ view: "setup", live: null, step: "run" });
}

// ---------------------------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------------------------

const rawCache = new Map<string, RawPart[]>();

async function partsFor(doc: RunDoc): Promise<Part[]> {
  const key = JSON.stringify(doc.source);
  let raw = rawCache.get(key);
  if (!raw) {
    raw = await rawFromSource(doc.source);
    rawCache.set(key, raw);
    if (rawCache.size > 3) rawCache.delete(rawCache.keys().next().value!);
  }
  return buildDesignParts(raw, doc.importOptions, doc.overrides, doc.groups).filter((p) => p.enabled);
}

export async function loadRun(id: string): Promise<LoadedRun> {
  let doc = await get("runs", id);
  if (!doc) throw new Error("That run no longer exists.");
  const fdoc = await get("fields", id);
  let parts: Part[] = [];
  let notice: string | undefined;
  try {
    parts = await partsFor(doc);
  } catch (e) {
    notice = `The car geometry could not be rebuilt: ${e instanceof Error ? e.message : String(e)}`;
  }
  const assessed = detectRunAxles(doc, parts);
  if (assessed !== doc) {
    doc = assessed;
    try { await put("runs", doc); } catch { notice ??= "Detected axles could not be saved in this browser."; }
  }
  let field = fdoc ? decodeField(fdoc.field) : null;
  if (OPENFOAM_ENABLED && fdoc && parts.length && doc.result.openfoam &&
      fdoc.openfoamSamplingVersion !== OPENFOAM_SAMPLING_VERSION) {
    try {
      const record = await getRun(doc.result.openfoam.run);
      const {low, high} = partsBounds(parts);
      field = await fetchField(record, low as Vec3, high as Vec3, doc.result.domain, FINAL_POINTS, doc.result.openfoam.offset);
      await put("fields", {...fdoc, field: encodeField(field), openfoamSamplingVersion: OPENFOAM_SAMPLING_VERSION});
    } catch {
      notice ??= "Saved airflow is shown. Connect to the OpenFOAM server to refresh road flow.";
    }
  }
  const animation = fdoc ? await restoreAnimation(fdoc) : undefined;
  let surface: (SurfaceSample | null)[] | null = fdoc ? decodeSurface(fdoc.surface) : null;
  if (surface) {
    // Surface values are per soup vertex; only use them when the rebuilt parts match exactly.
    surface = parts.map((p, i) => (surface![i] && surface![i]!.cp.length === p.positions.length / 3 ? surface![i] : null));
    if (surface.some((s) => !s) && parts.length) notice ??= "Some parts changed since this run; their surface pressure is not shown.";
  }
  const ranges = computeRanges(field, surface, doc.result.freestream, doc.settings.density);
  return { doc, parts, field, surface, ranges, notice, animation, animationRanges: animation ? animationRanges(animation, doc.settings.density) : undefined };
}

export async function openRun(id: string) {
  app.set({ busy: "Opening run…", library: false });
  try {
    const run = await loadRun(id);
    const { low, high } = partsBounds(run.parts);
    app.set((s) => ({ run, view: "results", compare: null, busy: null, viz: run.parts.length ? vizForCar(s.viz, low, high) : s.viz }));
    if (run.notice) toast(run.notice);
  } catch (e) {
    app.set({ busy: null });
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}

export async function deleteRun(id: string) {
  await remove("runs", id);
  await remove("fields", id);
  await removeAnimationFrames(id);
  const s = app.get();
  if (s.run?.doc.id === id) app.set({ run: null, view: "setup" });
  await collectFiles();
  refreshLists();
}

export async function startCompare(a: string, b: string) {
  app.set({ busy: "Opening runs…", library: false });
  try {
    const [ra, rb] = await Promise.all([loadRun(a), loadRun(b)]);
    const shared = mergeRanges(ra.ranges, rb.ranges);
    if (ra.animationRanges && rb.animationRanges) { const ar = mergeRanges(ra.animationRanges, rb.animationRanges); ra.animationRanges = rb.animationRanges = ar; }
    ra.ranges = rb.ranges = shared;
    const { low, high } = partsBounds(ra.parts.length ? ra.parts : rb.parts);
    app.set((s) => ({ compare: { a: ra, b: rb }, view: "compare", busy: null, viz: Number.isFinite(low[0]) ? vizForCar(s.viz, low, high) : s.viz }));
  } catch (e) {
    app.set({ busy: null });
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "run";

export function exportJSON(doc: RunDoc) {
  const analysis = assessedResult(doc);
  const inputs = doc.tyreLoadAssessment?.inputs ?? doc.settings;
  const body = {
    app: "EasyCFD Web",
    conventions: "Equivalent aerodynamic axle loads about the road below the front axle; drag at height contributes to pitch. Lift +Z, pitch +Y nose-up; kgf=N/9.80665. Tyre load estimates sum static axle weight and aerodynamic downforce per tyre pair, for level-road constant-speed driving. Negative total demand indicates loss of contact; braking, cornering and suspension dynamics are not modelled.",
    exportedAt: new Date().toISOString(),
    run: { id: doc.id, design: doc.designName, createdAt: new Date(doc.createdAt).toISOString(), adapter: doc.adapter },
    settings: doc.settings,
    geometry: doc.geometry,
    importOptions: doc.importOptions,
    result: doc.result,
    tyreLoadAssessment: doc.tyreLoadAssessment,
    axleLoadAssessment: doc.axleLoadAssessment ? {...doc.axleLoadAssessment, originalMomentOrigin:doc.result.aero?.origin,
      balance:analysis.balance, history:analysis.history, tyreLoads:estimateTyreLoads(analysis.balance, inputs)} : undefined,
  };
  download(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `${safe(doc.designName)}-${doc.id}.json`);
}

export function exportCSV(doc: RunDoc) {
  const analysis = assessedResult(doc);
  const loads = estimateTyreLoads(analysis.balance, doc.tyreLoadAssessment?.inputs ?? doc.settings);
  const rows = [`${doc.result.engine === "openfoam" ? "iteration" : "pseudo_time_s"},step,cd,cl,cs,pitch_Nm,front_lift_N,rear_lift_N,front_static_N,rear_static_N,front_tyre_total_N,rear_tyre_total_N`, ...analysis.history.map((h) => {
    const front = loads && h.frontLift !== undefined ? loads.front.staticN-h.frontLift : "";
    const rear = loads && h.rearLift !== undefined ? loads.rear.staticN-h.rearLift : "";
    return `${h.time},${h.step},${h.cd},${h.cl},${h.cs},${h.pitch ?? ""},${h.frontLift ?? ""},${h.rearLift ?? ""},${loads?.front.staticN ?? ""},${loads?.rear.staticN ?? ""},${front},${rear}`;
  })];
  download(new Blob([rows.join("\n")], { type: "text/csv" }), `${safe(doc.designName)}-${doc.id}-history.csv`);
}

export async function exportPNG(blob: Promise<Blob>, name: string) {
  try {
    download(await blob, `${safe(name)}.png`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}
