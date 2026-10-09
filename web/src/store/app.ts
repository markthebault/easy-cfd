// Application state and the actions the UI calls. Heavy work (parsing, grid preparation, solving)
// happens here or in workers; components only read state and call these functions.

import { checkGeometry, UNIT_SCALE, DEFAULT_IMPORT, LIMITS, suggestImport, type GeometryReport, type ImportOptions, type Part } from "../geometry/model";
import type { VizField } from "../solver/extract";
import { requestDevice, type GpuInfo } from "../solver/gpu";
import { probeServer, type ServerInfo } from "../engine/openfoam";
import { availableSettings, OPENFOAM_ENABLED } from "../engine/features";
import { DEFAULT_SETTINGS, type ForceSample, type Settings } from "../solver/types";
import type { VizSettings } from "../viz/stage";
import { collectFiles, get, getAll, hasKey, newId, put, remove, sha256 } from "./db";
import { applyGroups, applyOverrides, partKey, rawFromSource, summarize, turn90, type GroupView, type RawPart } from "./geometry";
import { buildParts } from "../geometry/model";
import { clearanceForRoadHeight, roadPosition } from "../geometry/roadPosition";
import { createStore } from "./store";
import type { DesignDoc, FileRef, LoadedRun, PartGroup, PartOverride, Ranges, RunDoc, SourceRef } from "./types";

export type Step = "car" | "conditions" | "run";
export type View = "setup" | "live" | "results" | "compare";
export type ThemePref = "system" | "dark" | "light";

export interface GpuState {
  status: "checking" | "ready" | "software" | "unavailable";
  adapter: string;
  message: string;
}

export interface LiveState {
  /** Solver of this run (absent: WebGPU). */
  engine?: "webgpu" | "openfoam";
  /** OpenFOAM: the server's stage text, iteration and iteration budget. */
  serverStage?: string;
  iteration?: number;
  iterations?: number;
  recordingTime?: number;
  recordingDuration?: number;
  stage: "preparing" | "solving" | "recording" | "finishing" | "saving";
  fraction: number;
  time: number;
  targetTime: number;
  /** Simulated seconds per flow pass (car length / speed). */
  passTime: number;
  steps: number;
  elapsed: number;
  cells: number;
  history: ForceSample[];
  field: VizField | null;
  ranges: Ranges | null;
  parts: Part[];
  settings: Settings;
  designName: string;
  snapshots: number;
  error: string | null;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

/** The OpenFOAM app's backend, when this page is served by it. */
export interface ServerState {
  status: "checking" | "ready" | "busy" | "unavailable";
  info: ServerInfo | null;
}

export interface AppState {
  theme: ThemePref;
  dark: boolean;
  gpu: GpuState;
  server: ServerState;
  design: DesignDoc | null;
  parts: Part[];
  /** Part groups of the current design, in display order. */
  groups: GroupView[];
  partsVersion: number;
  report: GeometryReport | null;
  busy: string | null;
  importError: string | null;
  confirmed: boolean;
  step: Step;
  view: View;
  live: LiveState | null;
  run: LoadedRun | null;
  compare: { a: LoadedRun; b: LoadedRun } | null;
  viz: VizSettings;
  showBox: boolean;
  help: "guide" | "solver" | null;
  library: boolean;
  designs: DesignDoc[];
  runs: RunDoc[];
  toasts: Toast[];
}

const reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const DEFAULT_VIZ: VizSettings = {
  surface: true,
  surfaceFlow: false,
  smoke: true,
  streamlines: false,
  slice: false,
  animation: false,
  animationLoop: true,
  wake: false,
  pressureCloud: false,
  cloudLevel: 0.15,
  cloudOpacity: 0.32,
  cloudSign: "both",
  forces: false,
  motion: true,
  windDirection: true,
  playing: !reducedMotion,
  flowSpeed: 1,
  smokeDensity: 0.3,
  smokeStyle: "filaments",
  trail: 0.6,
  rake: { x: -2.5, y: 0, z: 0.7, width: 1.6, height: 1.1 },
  stream: { x: -2.5, y: 0, z: 0.7, length: 1.2, count: 24, orientation: "vertical", animate: true },
  sliceAxis: 1,
  slicePos: 0,
  sliceField: "speed",
  sliceTracers: true,
  wakeLevel: 0,
  wakeColor: "speed",
};

const THEME_KEY = "easycfd.theme";
const LAST_DESIGN = "easycfd.lastDesign";

function systemDark() {
  return typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches;
}

const initialTheme = (localStorage.getItem(THEME_KEY) as ThemePref | null) ?? "system";

export const app = createStore<AppState>({
  theme: initialTheme,
  dark: initialTheme === "system" ? systemDark() : initialTheme === "dark",
  gpu: { status: "checking", adapter: "", message: "" },
  server: { status: OPENFOAM_ENABLED ? "checking" : "unavailable", info: null },
  design: null,
  parts: [],
  groups: [],
  partsVersion: 0,
  report: null,
  busy: null,
  importError: null,
  confirmed: false,
  step: "car",
  view: "setup",
  live: null,
  run: null,
  compare: null,
  viz: DEFAULT_VIZ,
  showBox: false,
  help: null,
  library: false,
  designs: [],
  runs: [],
  toasts: [],
});

// ---------------------------------------------------------------------------------------------
// Toasts, theme, GPU
// ---------------------------------------------------------------------------------------------

let toastId = 0;
export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = ++toastId;
  app.set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => app.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 9000 : 4500);
}

export function setTheme(theme: ThemePref) {
  localStorage.setItem(THEME_KEY, theme);
  app.set({ theme, dark: theme === "system" ? systemDark() : theme === "dark" });
}

if (typeof matchMedia !== "undefined")
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (app.get().theme === "system") app.set({ dark: systemDark() });
  });

let gpuPromise: Promise<GpuInfo> | null = null;

export function gpuDevice(): Promise<GpuInfo> {
  gpuPromise ??= requestDevice();
  return gpuPromise;
}

async function checkGpu() {
  try {
    const info = await gpuDevice();
    info.device.lost.then((l) => {
      gpuPromise = null;
      app.set({ gpu: { status: "unavailable", adapter: info.adapterName, message: `The GPU device was lost (${l.message || l.reason}). Reload the page to try again.` } });
    });
    app.set({
      gpu: info.software
        ? { status: "software", adapter: info.adapterName, message: "WebGPU runs on a software renderer here. Simulations will work but will be very slow." }
        : { status: "ready", adapter: info.adapterName, message: "" },
    });
  } catch (e) {
    app.set({
      gpu: {
        status: "unavailable",
        adapter: "",
        message: `${e instanceof Error ? e.message : String(e)} Use a current Chrome, Edge or Safari 26+ to run simulations. Saved results can still be viewed.`,
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Designs and geometry
// ---------------------------------------------------------------------------------------------

let raw: RawPart[] | null = null;
let rawKey = "";
let built: Part[] = [];
let builtKey = "";
let saveTimer = 0;

const sourceKey = (s: SourceRef) => JSON.stringify(s);

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const d = app.get().design;
    if (!d) return;
    await put("designs", d);
    localStorage.setItem(LAST_DESIGN, d.id);
    refreshLists();
  }, 400);
}

export async function refreshLists() {
  const [designs, runs] = await Promise.all([getAll("designs"), getAll("runs")]);
  designs.sort((a, b) => b.updatedAt - a.updatedAt);
  runs.sort((a, b) => b.createdAt - a.createdAt);
  app.set({ designs, runs });
}

const pause = () => new Promise((r) => setTimeout(r, 30));

/** Rebuild parts and the geometry report from the current design. */
async function rebuild(opts: { resetConfirm?: boolean; fit?: boolean } = {}) {
  const d = app.get().design;
  if (!d) {
    app.set({ parts: [], report: null });
    return;
  }
  const sk = sourceKey(d.source);
  try {
    if (!raw || rawKey !== sk) {
      app.set({ busy: "Reading geometry…" });
      await pause();
      raw = await rawFromSource(d.source);
      rawKey = sk;
      builtKey = "";
    }
    const bk = sk + JSON.stringify(d.importOptions);
    if (builtKey !== bk) {
      app.set({ busy: "Preparing parts…" });
      await pause();
      built = buildParts(raw, d.importOptions);
      builtKey = bk;
    }
    const grouped = applyGroups(applyOverrides(built, d.overrides), d.overrides, d.groups);
    const parts = grouped.parts;
    const hasStl = d.source.kind === "files" && d.source.files.some((f) => f.name.toLowerCase().endsWith(".stl"));
    // The local OpenFOAM workflow measures the model without a geometry
    // acceptance preflight. WebGPU applies its own checks at the Run step.
    const report = checkGeometry(parts, hasStl, !OPENFOAM_ENABLED);
    app.set((s) => ({
      parts,
      groups: grouped.groups,
      report,
      busy: null,
      partsVersion: s.partsVersion + 1,
      confirmed: opts.resetConfirm === false ? s.confirmed : false,
    }));
  } catch (e) {
    app.set({ busy: null });
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}

export function newDesignDoc(name: string, source: SourceRef, settings: Settings = DEFAULT_SETTINGS): DesignDoc {
  const now = Date.now();
  return { id: newId("d"), name, createdAt: now, updatedAt: now, source, importOptions: { ...DEFAULT_IMPORT }, overrides: {}, settings: { ...settings } };
}

function setDesign(d: DesignDoc, rebuildOpts?: Parameters<typeof rebuild>[0]) {
  app.set({ design: { ...d, settings: availableSettings(d.settings), updatedAt: Date.now() } });
  scheduleSave();
  return rebuild(rebuildOpts);
}

export async function loadSample(wing = false) {
  const cur = app.get().design;
  if (cur && cur.source.kind === "sample") {
    await setDesign({ ...cur, source: { kind: "sample", wing } });
    return;
  }
  app.set({ step: "car", view: "setup", run: null });
  await setDesign(newDesignDoc(wing ? "Sample car with wing" : "Sample car", { kind: "sample", wing }));
}

const SUPPORTED = /\.(stl|obj|glb|gltf|step|stp|igs|iges)$/i;

export async function importFiles(files: File[], add: boolean) {
  const usable = files.filter((f) => SUPPORTED.test(f.name));
  const skipped = files.length - usable.length;
  if (!usable.length) {
    toast(skipped ? "Those files are not STEP, IGES, STL, OBJ, GLB or glTF." : "No files selected.", "error");
    return;
  }
  const total = usable.reduce((n, f) => n + f.size, 0);
  if (usable.length > LIMITS.files || total > LIMITS.bytes) {
    toast(`Import up to ${LIMITS.files} files and ${LIMITS.bytes / 1048576} MB at a time.`, "error");
    return;
  }
  if (app.get().busy) return;
  app.set({ busy: "Reading files…", importError:null });
  try {
    const cur = app.get().design;
    const adding = add && cur?.source.kind === "files";
    const refs: FileRef[] = adding ? [...(cur!.source as { files: FileRef[] }).files] : [];
    const data = new Map<string, ArrayBuffer>();
    for (const f of usable) {
      const bytes = await f.arrayBuffer();
      const hash = await sha256(bytes);
      data.set(hash, bytes);
      if (!refs.some((r) => r.hash === hash && r.name === f.name)) refs.push({ hash, name: f.name, base: !adding, size: f.size });
    }
    const source: SourceRef = { kind: "files", files: refs };
    app.set({ busy: "Reading geometry…" });
    const parsed = await rawFromSource(source, data, name => app.set({busy:`Reading ${name}…`}));
    if (!parsed.length || parsed.some(p => !p.positions.length || p.positions.length % 9 || p.positions.some(v => !Number.isFinite(v))))
      throw new Error("The file has no usable finite triangle surfaces.");
    if (parsed.reduce((n, p) => n + p.positions.length / 9, 0) > LIMITS.triangles)
      throw new Error(`Import at most ${LIMITS.triangles.toLocaleString()} triangles.`);
    for (const f of refs) {
      const bytes = data.get(f.hash);
      if (bytes && !(await hasKey("files", f.hash))) await put("files", { hash: f.hash, name: f.name, bytes });
    }
    raw = parsed;
    rawKey = sourceKey(source);
    builtKey = "";
    if (skipped) toast(`${skipped} file${skipped > 1 ? "s" : ""} skipped (unsupported format).`);
    app.set({ view: "setup", step: "car", run: null });
    if (adding) await setDesign({ ...cur!, source });
    else {
      const d = newDesignDoc(usable[0].name.replace(/\.[^.]+$/, ""), source, cur ? {...cur.settings,axles:undefined} : undefined);
      d.importOptions = suggestImport(parsed);
      await setDesign(d);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    app.set({ busy: null, importError:message });
    toast(message, "error");
  }
}

export async function applyPreparedModel(preview: import("../engine/prepare").PreparationPreview, sourceDesignId: string) {
  const name = app.get().design?.name ?? "Model";
  await importFiles([new File([preview.bytes], `${name} prepared.stl`, {type:"model/stl"})], false);
  const d = app.get().design;
  if (d && d.id !== sourceDesignId) await setDesign({...d,preparation:{sourceDesignId,report:preview.report},settings:{...d.settings,wheels:false,axles:undefined}});
}

export async function removeFile(hash: string) {
  const d = app.get().design;
  if (!d || d.source.kind !== "files") return;
  const files = d.source.files.filter((f) => f.hash !== hash);
  if (!files.some((f) => f.base) && files.length) files[0] = { ...files[0], base: true };
  if (!files.length) return newDesign();
  const removesBase = d.source.files.some(f=>f.hash === hash && f.base);
  await setDesign({ ...d, settings:removesBase ? {...d.settings,axles:undefined} : d.settings, source: { kind: "files", files } });
}

export function setImport(patch: Partial<ImportOptions>) {
  const d = app.get().design;
  if (d) {
    const changedAxes = (patch.forward && patch.forward !== d.importOptions.forward) || (patch.up && patch.up !== d.importOptions.up);
    const scale = patch.units ? UNIT_SCALE[patch.units]/UNIT_SCALE[d.importOptions.units] : 1;
    const axles = changedAxes ? undefined : d.settings.axles ? {...d.settings.axles,frontX:d.settings.axles.frontX*scale,rearX:d.settings.axles.rearX*scale,centrelineY:d.settings.axles.centrelineY*scale} : undefined;
    setDesign({ ...d, settings:{...d.settings,axles}, importOptions: { ...d.importOptions, ...patch } });
  }
}

export function setRoadHeight(height: number, simulationGap = false) {
  const s = app.get(), d = s.design;
  if (!d || s.busy || !Number.isFinite(height) || height < 0 || height > 2) return;
  const position = roadPosition(s.parts);
  const anchor = simulationGap ? position.lowest : position.height;
  if (anchor === null) return;
  const clearance = clearanceForRoadHeight(d.importOptions.clearance, anchor, height);
  if (Math.abs(clearance - d.importOptions.clearance) < 1e-8) return;
  setImport({ clearance });
}

export function applyHint(apply: Partial<ImportOptions> & { turn?: boolean }) {
  const d = app.get().design;
  if (!d) return;
  const { turn, ...rest } = apply;
  let o = { ...d.importOptions, ...rest };
  if (turn) o = turn90(o);
  setImport(o);
}

export function setOverride(key: string, patch: PartOverride) {
  const d = app.get().design;
  if (!d) return;
  setDesign({ ...d, overrides: { ...d.overrides, [key]: { ...d.overrides[key], ...patch } } });
}

// ---------------------------------------------------------------------------------------------
// Part groups
// ---------------------------------------------------------------------------------------------

/** Write a group's name and switch into the design (automatic groups are materialised on first change). */
function upsertGroup(id: string, patch: Partial<PartGroup>, resetConfirm = true) {
  const d = app.get().design;
  if (!d) return;
  const view = app.get().groups.find((g) => g.id === id);
  const list = [...(d.groups ?? [])];
  const i = list.findIndex((g) => g.id === id);
  const next: PartGroup = { id, name: view?.name ?? "Group", enabled: view?.enabled ?? true, ...(i >= 0 ? list[i] : {}), ...patch };
  if (i >= 0) list[i] = next;
  else list.push(next);
  return setDesign({ ...d, groups: list }, { resetConfirm });
}

/** Switching groups does not change the geometry itself, so the checklist stays confirmed. */
export const setGroupEnabled = (id: string, enabled: boolean) => upsertGroup(id, { enabled }, false);
export const renameGroup = (id: string, name: string) => upsertGroup(id, { name: name.trim() || "Group" }, false);
export const setGroupDetail = (id: string, detail: "auto" | "always" | "off") => upsertGroup(id, { detail }, false);

/** Switch on exactly one group among `ids` (e.g. one rear-wing version) and switch the others off. */
export function soloGroup(id: string, ids: string[]) {
  const d = app.get().design;
  if (!d) return;
  const views = app.get().groups;
  const list = [...(d.groups ?? [])];
  for (const gid of ids) {
    const view = views.find((g) => g.id === gid);
    const i = list.findIndex((g) => g.id === gid);
    const next: PartGroup = { id: gid, name: view?.name ?? "Group", enabled: gid === id };
    if (i >= 0) list[i] = { ...list[i], enabled: gid === id };
    else list.push(next);
  }
  return setDesign({ ...d, groups: list }, { resetConfirm: false });
}

export function createGroup(name: string, partKeys: string[] = []): string | undefined {
  const d = app.get().design;
  if (!d) return;
  const id = `g:u:${Math.random().toString(36).slice(2, 9)}`;
  const overrides = { ...d.overrides };
  for (const k of partKeys) overrides[k] = { ...overrides[k], group: id };
  setDesign({ ...d, groups: [...(d.groups ?? []), { id, name: name.trim() || "New group", enabled: true }], overrides }, { resetConfirm: false });
  return id;
}

/** Move a part to another group. Moving it back to its automatic group clears the assignment. */
export function moveToGroup(key: string, groupId: string) {
  const d = app.get().design;
  if (!d) return;
  setDesign({ ...d, overrides: { ...d.overrides, [key]: { ...d.overrides[key], group: groupId } } }, { resetConfirm: false });
}

/** Delete a user group; its parts return to their automatic groups. */
export function deleteGroup(id: string) {
  const d = app.get().design;
  if (!d) return;
  const overrides: typeof d.overrides = {};
  for (const [k, o] of Object.entries(d.overrides)) overrides[k] = o.group === id ? { ...o, group: undefined } : o;
  setDesign({ ...d, groups: (d.groups ?? []).filter((g) => g.id !== id), overrides }, { resetConfirm: false });
}

export function setSettings(patch: Partial<Settings>) {
  const d = app.get().design;
  if (!d) return;
  app.set({ design: { ...d, settings: availableSettings({ ...d.settings, ...patch }), updatedAt: Date.now() } });
  scheduleSave();
}

export function renameCurrent(name: string) {
  const d = app.get().design;
  if (d && name.trim()) {
    app.set({ design: { ...d, name: name.trim(), updatedAt: Date.now() } });
    scheduleSave();
  }
}

export const setConfirmed = (confirmed: boolean) => app.set({ confirmed });
export const goStep = (step: Step) => app.set({ step, view: "setup" });

export function newDesign() {
  raw = null;
  rawKey = "";
  localStorage.removeItem(LAST_DESIGN);
  app.set({ design: null, parts: [], report: null, step: "car", view: "setup", run: null, confirmed: false, library: false });
}

export async function openDesign(id: string) {
  const d = await get("designs", id);
  if (!d) {
    toast("That design was deleted. Its runs are still saved.");
    return;
  }
  localStorage.setItem(LAST_DESIGN, id);
  app.set({ design: { ...d, settings: availableSettings(d.settings) }, step: "car", view: "setup", run: null, library: false, compare: null });
  await rebuild();
}

export async function renameDesign(id: string, name: string) {
  const d = await get("designs", id);
  if (!d || !name.trim()) return;
  const next = { ...d, name: name.trim(), updatedAt: Date.now() };
  await put("designs", next);
  if (app.get().design?.id === id) app.set({ design: next });
  refreshLists();
}

export async function duplicateDesign(id: string) {
  const d = await get("designs", id);
  if (!d) return;
  const copy = { ...structuredClone(d), id: newId("d"), name: `${d.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() };
  await put("designs", copy);
  refreshLists();
}

export async function deleteDesign(id: string) {
  await remove("designs", id);
  if (app.get().design?.id === id) newDesign();
  await collectFiles();
  refreshLists();
}

// ---------------------------------------------------------------------------------------------
// Visualisation settings
// ---------------------------------------------------------------------------------------------

export function setViz(patch: Partial<VizSettings>) {
  app.set((s) => ({ viz: { ...s.viz, ...patch } }));
}

/** Place rakes and the slice for a car of the given bounds; layer choices are kept. */
export function vizForCar(v: VizSettings, low: number[], high: number[]): VizSettings {
  const L = high[0] - low[0], W = high[1] - low[1], H = high[2] - low[2];
  const zc = (low[2] + high[2]) / 2;
  const yc = (low[1] + high[1]) / 2;
  return {
    ...v,
    animation: false,
    rake: { x: low[0] - 0.14 * L, y: yc, z: zc, width: W * 0.9, height: H * 0.9 },
    stream: { ...v.stream, x: low[0] - 0.12 * L, y: yc + 0.02 * W, z: zc, length: v.stream.orientation === "vertical" ? H * 1.05 : W * 1.2 },
    slicePos: v.sliceAxis === 1 ? yc : v.sliceAxis === 2 ? zc : high[0] + 0.3 * L,
  };
}

export function partsBounds(parts: Part[]): { low: number[]; high: number[] } {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    if (!p.enabled) continue;
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3)
      for (let c = 0; c < 3; c++) {
        if (a[i + c] < low[c]) low[c] = a[i + c];
        if (a[i + c] > high[c]) high[c] = a[i + c];
      }
  }
  return { low, high };
}

export function dragHandle(name: "rake" | "stream" | "slice", pos: { x: number; y: number; z: number }) {
  const v = app.get().viz;
  if (name === "rake") setViz({ rake: { ...v.rake, x: pos.x, y: pos.y, z: pos.z } });
  else if (name === "stream") setViz({ stream: { ...v.stream, x: pos.x, y: pos.y, z: pos.z } });
  else setViz({ slicePos: [pos.x, pos.y, pos.z][v.sliceAxis] });
}

export function closeCompare() {
  app.set((s) => ({ compare: null, view: s.run ? "results" : "setup" }));
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

export async function checkServer() {
  const info = await probeServer();
  app.set({ server: { status: info ? (info.ready ? "ready" : "busy") : "unavailable", info } });
}

export async function init() {
  checkGpu();
  checkServer();
  try {
    await refreshLists();
    const last = localStorage.getItem(LAST_DESIGN);
    if (last) await openDesign(last);
  } catch (e) {
    toast(`Browser storage is unavailable: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export { partKey, summarize };
