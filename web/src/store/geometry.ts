// From a design's source (sample car or stored files) to world-space parts and solver input.

import { buildParts, readFile, type AxisName, type ImportOptions, type Part, type RawMesh } from "../geometry/model";
import { sampleCar } from "../geometry/sample";
import type { SolverPart, Vec3 } from "../solver/types";
import { get } from "./db";
import type { GeometrySummary, PartGroup, PartOverride, SourceRef } from "./types";
import type { GeometryReport } from "../geometry/model";

export type RawPart = RawMesh & { base: boolean };

export const SAMPLE_FILE = "Sample car";

export const partKey = (p: { file: string; name: string }) => `${p.file}::${p.name}`;

export async function rawFromSource(source: SourceRef, bytes?: Map<string, ArrayBuffer>): Promise<RawPart[]> {
  if (source.kind === "sample")
    return sampleCar(source.wing).map((p) => ({ name: p.name, file: SAMPLE_FILE, positions: p.positions, base: true }));
  const out: RawPart[] = [];
  for (const f of source.files) {
    const data = bytes?.get(f.hash) ?? (await get("files", f.hash))?.bytes;
    if (!data) throw new Error(`${f.name} is missing from the browser storage.`);
    const meshes = await readFile({ name: f.name, bytes: data, base: f.base });
    for (const m of meshes) out.push({ ...m, base: f.base });
  }
  return out;
}

function boundsCenter(a: Float32Array): { center: Vec3; radius: number } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += 3)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], a[i + c]);
      hi[c] = Math.max(hi[c], a[i + c]);
    }
  return { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], radius: Math.max(0.01, (hi[2] - lo[2]) / 2) };
}

export function applyOverrides(parts: Part[], overrides: Record<string, PartOverride>): Part[] {
  return parts.map((p) => {
    const o = overrides[partKey(p)];
    if (!o) return p;
    const role = o.role ?? p.role;
    let wheel = p.wheel;
    if (role === "wheel") {
      wheel ??= boundsCenter(p.positions);
      if (o.radius) wheel = { ...wheel, radius: o.radius };
    } else wheel = null;
    return { ...p, enabled: o.enabled ?? p.enabled, role, wheel };
  });
}

export function buildDesignParts(raw: RawPart[], opts: ImportOptions, overrides: Record<string, PartOverride>, groups?: PartGroup[]): Part[] {
  return applyGroups(applyOverrides(buildParts(raw, opts), overrides), overrides, groups).parts;
}

// ---------------------------------------------------------------------------------------------
// Groups: parts switched on and off together
// ---------------------------------------------------------------------------------------------

const AERO: [RegExp, string, string][] = [
  [/wing|spoiler|endplate|gurney|swan/i, "g:rear-wing", "Rear wing"],
  [/splitter|front[_ -]?lip|canard|dive[_ -]?plane/i, "g:splitter", "Splitter"],
  [/diffuser/i, "g:diffuser", "Diffuser"],
];

/** Automatic group of a part: wheels, recognised aero parts, one group per added file, else body. */
export function defaultGroup(p: Part): { id: string; name: string } {
  if (p.role === "wheel") return { id: "g:wheels", name: "Wheels" };
  if (p.base === false) return { id: `g:file:${p.file}`, name: p.file.replace(/\.[^.]+$/, "") };
  for (const [re, id, name] of AERO) if (re.test(p.name) || re.test(p.file)) return { id, name };
  return { id: "g:body", name: "Body" };
}

export interface GroupView extends PartGroup {
  parts: Part[];
  /** Created automatically from the parts (not by the user). */
  auto: boolean;
}

/**
 * Assign every part to its group and apply group switches: a part is simulated only when both
 * the part and its group are on. Returns the parts and the groups in display order.
 */
export function applyGroups(parts: Part[], overrides: Record<string, PartOverride>, groups: PartGroup[] = []): { parts: Part[]; groups: GroupView[] } {
  const views = new Map<string, GroupView>();
  for (const g of groups) views.set(g.id, { ...g, parts: [], auto: g.id.startsWith("g:") && !g.id.startsWith("g:u:") });
  const out = parts.map((p) => {
    const def = defaultGroup(p);
    const wanted = overrides[partKey(p)]?.group;
    const id = wanted && views.has(wanted) ? wanted : def.id;
    if (!views.has(id)) views.set(id, { id, name: def.name, enabled: true, parts: [], auto: true });
    const g = views.get(id)!;
    const q = { ...p, group: id, selfEnabled: p.enabled, enabled: p.enabled && g.enabled };
    g.parts.push(q);
    return q;
  });
  const order = (g: GroupView) => (g.id === "g:body" ? 0 : g.id === "g:wheels" ? 1 : 2);
  const list = [...views.values()].sort((a, b) => order(a) - order(b));
  return { parts: out, groups: list };
}

/**
 * Solver input: every part whose own switch is on. Parts in switched-off groups go along as
 * inactive, so they shape the grid (and its detail refinement) without being simulated: all
 * variants of a design then run on identical cells.
 */
export function toSolverParts(parts: Part[], groups: PartGroup[] = []): SolverPart[] {
  const detail = new Map(groups.map((g) => [g.id, g.detail ?? "auto"] as const));
  return parts
    .filter((p) => p.selfEnabled ?? p.enabled)
    .map((p) => ({
      id: p.id, name: p.name, role: p.role, positions: p.positions, wheel: p.role === "wheel" ? p.wheel : null,
      active: p.enabled, detail: (p.group && detail.get(p.group)) || "auto", group: p.group,
    }));
}

/** Bounds of the parts that shape the grid (own switch on, whatever their group's switch). */
export function gridBounds(parts: Part[]): { low: Vec3; high: Vec3 } | null {
  const shaping = parts.filter((p) => p.selfEnabled ?? p.enabled);
  if (!shaping.length) return null;
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of shaping)
    for (let i = 0; i < p.positions.length; i += 3)
      for (let c = 0; c < 3; c++) {
        const v = p.positions[i + c];
        if (v < low[c]) low[c] = v;
        if (v > high[c]) high[c] = v;
      }
  return { low, high };
}

export function summarize(parts: Part[], report: Pick<GeometryReport, "dimensions" | "triangles" | "frontalArea">, groups?: GroupView[]): GeometrySummary {
  return {
    dimensions: report.dimensions,
    triangles: report.triangles,
    frontalArea: report.frontalArea,
    parts: parts.map((p) => ({
      key: partKey(p), name: p.name, role: p.role, enabled: p.enabled, triangles: p.positions.length / 9, radius: p.wheel?.radius ?? null, group: p.group,
    })),
    groups: groups?.map((g) => ({ id: g.id, name: g.name, enabled: g.enabled, parts: g.parts.length })),
  };
}

// ---------------------------------------------------------------------------------------------
// Orientation quick actions on axis names
// ---------------------------------------------------------------------------------------------

const vec = (a: AxisName): Vec3 => {
  const v: Vec3 = [0, 0, 0];
  v["XYZ".indexOf(a[1])] = a[0] === "-" ? -1 : 1;
  return v;
};
const name = (v: Vec3): AxisName => {
  const i = v.findIndex((c) => Math.abs(c) > 0.5);
  return `${v[i] < 0 ? "-" : "+"}${"XYZ"[i]}` as AxisName;
};
const neg = (a: AxisName): AxisName => (a[0] === "-" ? "+" : "-") + a[1] as AxisName;

/** Turn the car 90° about its up axis. */
export function turn90(o: ImportOptions): ImportOptions {
  const f = vec(o.forward), u = vec(o.up);
  const c: Vec3 = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]];
  return { ...o, forward: name(c) };
}

export const swapNoseTail = (o: ImportOptions): ImportOptions => ({ ...o, forward: neg(o.forward) });
export const flipUpsideDown = (o: ImportOptions): ImportOptions => ({ ...o, up: neg(o.up) });

/** Forward and up must be perpendicular; pick a valid up when the user picks a clashing forward. */
export function fixAxes(o: ImportOptions, changed: "forward" | "up"): ImportOptions {
  if (o.forward[1] !== o.up[1]) return o;
  const taken = changed === "forward" ? o.forward[1] : o.up[1];
  const other = (["Z", "Y", "X"] as const).find((a) => a !== taken)!;
  return changed === "forward" ? { ...o, up: `+${other}` as AxisName } : { ...o, forward: `-${other === "Z" ? "Y" : other}` as AxisName };
}
