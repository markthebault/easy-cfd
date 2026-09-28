// Geometry import and preparation. Everything runs locally; files never leave the browser.
// World frame after import: metres, nose toward −X (air flows toward +X), +Z up, road at Z = 0.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { parseSTL } from "./stl";
import type { Vec3 } from "../solver/types";

export type Units = "m" | "mm" | "cm" | "in";
export type AxisName = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export const UNIT_SCALE: Record<Units, number> = { m: 1, mm: 0.001, cm: 0.01, in: 0.0254 };

export interface ImportOptions {
  units: Units;
  forward: AxisName;
  up: AxisName;
  clearance: number;
  split: boolean;
}

export const DEFAULT_IMPORT: ImportOptions = { units: "m", forward: "-X", up: "+Z", clearance: 0.01, split: true };

export interface SourceFile {
  name: string;
  bytes: ArrayBuffer;
  /** Base files define the car's position; added parts keep their exported position relative to it. */
  base: boolean;
}

export interface Part {
  id: string;
  name: string;
  file: string;
  role: "body" | "wheel";
  enabled: boolean;
  /** World coordinates, 9 floats per triangle. */
  positions: Float32Array;
  wheel: { center: Vec3; radius: number } | null;
  /** From a base file (true) or added with "Add parts" (false). */
  base?: boolean;
  /** Group id (see store/geometry.ts); set when design groups are applied. */
  group?: string;
  /** The part's own switch, before its group's switch is applied. */
  selfEnabled?: boolean;
}

export interface RawMesh {
  name: string;
  file: string;
  positions: Float32Array; // file coordinates
}

export const LIMITS = { files: 20, bytes: 150 * 1024 * 1024, parts: 60, triangles: 3_000_000, minLength: 0.1, maxLength: 15 };

// ---------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------

function soupFromGeometry(g: THREE.BufferGeometry, matrix?: THREE.Matrix4): Float32Array {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  if (matrix) geo.applyMatrix4(matrix);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[3 * i] = pos.getX(i);
    out[3 * i + 1] = pos.getY(i);
    out[3 * i + 2] = pos.getZ(i);
  }
  geo.dispose();
  return out.subarray(0, out.length - (out.length % 9));
}

export async function readFile(file: SourceFile): Promise<RawMesh[]> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const stem = file.name.replace(/\.[^.]+$/, "");
  if (ext === "stl") return [{ name: stem, file: file.name, positions: parseSTL(file.bytes) }];
  if (ext === "obj") {
    const obj = new OBJLoader().parse(new TextDecoder().decode(file.bytes));
    const out: RawMesh[] = [];
    obj.updateMatrixWorld(true);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) out.push({ name: m.name || stem, file: file.name, positions: soupFromGeometry(m.geometry, m.matrixWorld) });
    });
    return out;
  }
  if (ext === "glb" || ext === "gltf") {
    const gltf = await new GLTFLoader().parseAsync(file.bytes, "");
    const out: RawMesh[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) out.push({ name: m.name || stem, file: file.name, positions: soupFromGeometry(m.geometry, m.matrixWorld) });
    });
    return out;
  }
  throw new Error(`${file.name}: unsupported format. Use STL, OBJ, GLB or glTF.`);
}

// ---------------------------------------------------------------------------------------------
// Connected components (vertices welded on a 1e-6 relative grid)
// ---------------------------------------------------------------------------------------------

export function splitComponents(tri: Float32Array): Float32Array[] {
  const n = tri.length / 9;
  if (n === 0) return [];
  let span = 0;
  for (let i = 0; i < tri.length; i++) span = Math.max(span, Math.abs(tri[i]));
  const q = Math.max(span, 1e-9) * 1e-6;
  const ids = new Map<string, number>();
  const vert = new Int32Array(n * 3);
  for (let v = 0; v < n * 3; v++) {
    const key = `${Math.round(tri[3 * v] / q)},${Math.round(tri[3 * v + 1] / q)},${Math.round(tri[3 * v + 2] / q)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    vert[v] = id;
  }
  const parent = new Int32Array(ids.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let t = 0; t < n; t++) {
    const a = find(vert[3 * t]), b = find(vert[3 * t + 1]), c = find(vert[3 * t + 2]);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    const r = find(vert[3 * t]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((list) => {
      const out = new Float32Array(list.length * 9);
      list.forEach((t, i) => out.set(tri.subarray(t * 9, t * 9 + 9), i * 9));
      return out;
    });
}

// ---------------------------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------------------------

function axisVector(a: AxisName): Vec3 {
  const v: Vec3 = [0, 0, 0];
  v["XYZ".indexOf(a[1])] = a[0] === "-" ? -1 : 1;
  return v;
}

/** Rotation taking file axes to world: forward → −X, up → +Z. Returns a 3×3 row-major matrix. */
export function orientation(forward: AxisName, up: AxisName): number[] {
  const f = axisVector(forward);
  const u = axisVector(up);
  const x: Vec3 = [-f[0], -f[1], -f[2]]; // world +X in file coordinates
  const z = u;
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [...x, ...y, ...z];
}

export function transformSoup(tri: Float32Array, m: number[], scale: number, offset: Vec3 = [0, 0, 0]): Float32Array {
  const out = new Float32Array(tri.length);
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i] * scale, b = tri[i + 1] * scale, c = tri[i + 2] * scale;
    out[i] = m[0] * a + m[1] * b + m[2] * c + offset[0];
    out[i + 1] = m[3] * a + m[4] * b + m[5] * c + offset[1];
    out[i + 2] = m[6] * a + m[7] * b + m[8] * c + offset[2];
  }
  return out;
}

export function soupBounds(list: Float32Array[]): { low: Vec3; high: Vec3 } {
  const low: Vec3 = [Infinity, Infinity, Infinity];
  const high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const a of list)
    for (let i = 0; i < a.length; i += 3)
      for (let c = 0; c < 3; c++) {
        if (a[i + c] < low[c]) low[c] = a[i + c];
        if (a[i + c] > high[c]) high[c] = a[i + c];
      }
  return { low, high };
}

const WHEEL_NAME = /(wheel|tyre|tire|rim|rad|roue)/i;

/** Heuristic: a part named like a wheel, or a compact round-ish part touching the road near a corner. */
function looksLikeWheel(name: string, low: Vec3, high: Vec3, carLow: Vec3, carHigh: Vec3): boolean {
  if (WHEEL_NAME.test(name)) return true;
  const dx = high[0] - low[0], dy = high[1] - low[1], dz = high[2] - low[2];
  const L = carHigh[0] - carLow[0];
  const nearRoad = low[2] - carLow[2] < 0.03 * L;
  const round = Math.abs(dx - dz) < 0.12 * Math.max(dx, dz) && dy < 0.8 * dz && dz > 0.08 * L && dz < 0.35 * L;
  const outboard = Math.min(Math.abs(high[1] - carHigh[1]), Math.abs(low[1] - carLow[1])) < 0.15 * (carHigh[1] - carLow[1]);
  return nearRoad && round && outboard;
}

/**
 * Convert raw meshes to world-space parts. Base meshes are centred in X/Y and lifted so their lowest
 * point is at `clearance`; added meshes (base=false) receive the same transform.
 */
export function buildParts(raw: (RawMesh & { base: boolean })[], opts: ImportOptions, previous: Part[] = []): Part[] {
  const m = orientation(opts.forward, opts.up);
  const s = UNIT_SCALE[opts.units];
  const pieces: { name: string; file: string; base: boolean; positions: Float32Array }[] = [];
  for (const r of raw) {
    const rotated = transformSoup(r.positions, m, s);
    const comps = opts.split ? splitComponents(rotated) : [rotated];
    comps.forEach((c, i) => pieces.push({ name: comps.length > 1 ? `${r.name} ${i + 1}` : r.name, file: r.file, base: r.base, positions: c }));
  }
  // Too many fragments: keep the largest as parts, merge the rest into one body part per file.
  if (pieces.length > LIMITS.parts) {
    pieces.sort((a, b) => b.positions.length - a.positions.length);
    const keep = pieces.slice(0, LIMITS.parts - 1);
    const rest = pieces.slice(LIMITS.parts - 1);
    const total = rest.reduce((n, p) => n + p.positions.length, 0);
    const merged = new Float32Array(total);
    let o = 0;
    for (const p of rest) {
      merged.set(p.positions, o);
      o += p.positions.length;
    }
    keep.push({ name: "Small fragments (merged)", file: rest[0].file, base: rest[0].base, positions: merged });
    pieces.length = 0;
    pieces.push(...keep);
  }
  const base = pieces.filter((p) => p.base).map((p) => p.positions);
  const { low, high } = soupBounds(base.length ? base : pieces.map((p) => p.positions));
  const offset: Vec3 = [-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, opts.clearance - low[2]];
  const carLow: Vec3 = [low[0] + offset[0], low[1] + offset[1], low[2] + offset[2]];
  const carHigh: Vec3 = [high[0] + offset[0], high[1] + offset[1], high[2] + offset[2]];
  return pieces.map((p, i) => {
    const positions = transformSoup(p.positions, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1, offset);
    const b = soupBounds([positions]);
    const prev = previous.find((q) => q.name === p.name && q.file === p.file);
    const wheelish = prev ? prev.role === "wheel" : looksLikeWheel(p.name, b.low, b.high, carLow, carHigh);
    const center: Vec3 = [(b.low[0] + b.high[0]) / 2, (b.low[1] + b.high[1]) / 2, (b.low[2] + b.high[2]) / 2];
    return {
      id: `part${i}`,
      name: p.name,
      file: p.file,
      role: wheelish ? "wheel" : "body",
      enabled: prev ? prev.enabled : true,
      positions,
      wheel: wheelish ? { center, radius: Math.max(0.01, (b.high[2] - b.low[2]) / 2) } : null,
      base: p.base,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Checks and estimates
// ---------------------------------------------------------------------------------------------

export interface GeometryReport {
  low: Vec3;
  high: Vec3;
  dimensions: Vec3;
  triangles: number;
  frontalArea: number;
  errors: string[];
  warnings: string[];
  openParts: string[];
  hints: { label: string; apply: Partial<ImportOptions> & { turn?: boolean } }[];
}

function openEdges(tri: Float32Array): number {
  let span = 0;
  for (let i = 0; i < tri.length; i++) span = Math.max(span, Math.abs(tri[i]));
  const q = Math.max(span, 1e-9) * 1e-6;
  const ids = new Map<string, number>();
  const id = (v: number) => {
    const key = `${Math.round(tri[3 * v] / q)},${Math.round(tri[3 * v + 1] / q)},${Math.round(tri[3 * v + 2] / q)}`;
    let i = ids.get(key);
    if (i === undefined) ids.set(key, (i = ids.size));
    return i;
  };
  const edges = new Map<number, number>();
  const n = tri.length / 9;
  for (let t = 0; t < n; t++) {
    const a = id(3 * t), b = id(3 * t + 1), c = id(3 * t + 2);
    for (const [p, r] of [[a, b], [b, c], [c, a]]) {
      const key = p < r ? p * 4194304 + r : r * 4194304 + p;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c !== 2) open++;
  return open;
}

/** Exact projected area on the Y-Z plane by rasterising every triangle on a fine grid. */
export function frontalArea(list: Float32Array[], resolution = 600): number {
  const { low, high } = soupBounds(list);
  const span = Math.max(high[1] - low[1], high[2] - low[2]);
  if (!Number.isFinite(span) || span <= 0) return 0;
  const cell = span / resolution;
  const ny = Math.ceil((high[1] - low[1]) / cell) + 1;
  const nz = Math.ceil((high[2] - low[2]) / cell) + 1;
  const mask = new Uint8Array(ny * nz);
  for (const tri of list)
    for (let o = 0; o < tri.length; o += 9) {
      const y0 = tri[o + 1], z0 = tri[o + 2], y1 = tri[o + 4], z1 = tri[o + 5], y2 = tri[o + 7], z2 = tri[o + 8];
      const area = (y1 - y0) * (z2 - z0) - (y2 - y0) * (z1 - z0);
      if (Math.abs(area) < 1e-14) continue;
      const jl = Math.max(0, Math.floor((Math.min(y0, y1, y2) - low[1]) / cell));
      const jh = Math.min(ny - 1, Math.ceil((Math.max(y0, y1, y2) - low[1]) / cell));
      const kl = Math.max(0, Math.floor((Math.min(z0, z1, z2) - low[2]) / cell));
      const kh = Math.min(nz - 1, Math.ceil((Math.max(z0, z1, z2) - low[2]) / cell));
      for (let k = kl; k <= kh; k++) {
        const qz = low[2] + (k + 0.5) * cell;
        for (let j = jl; j <= jh; j++) {
          const qy = low[1] + (j + 0.5) * cell;
          const w0 = (y1 - qy) * (z2 - qz) - (y2 - qy) * (z1 - qz);
          const w1 = (y2 - qy) * (z0 - qz) - (y0 - qy) * (z2 - qz);
          const w2 = (y0 - qy) * (z1 - qz) - (y1 - qy) * (z0 - qz);
          if (area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0) mask[j + ny * k] = 1;
        }
      }
    }
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count * cell * cell;
}

export function checkGeometry(parts: Part[], hasStl: boolean): GeometryReport {
  const enabled = parts.filter((p) => p.enabled);
  const errors: string[] = [];
  const warnings: string[] = [];
  const hints: GeometryReport["hints"] = [];
  if (!enabled.length) errors.push("Switch on at least one part.");
  const { low, high } = soupBounds(enabled.map((p) => p.positions));
  const dims: Vec3 = enabled.length ? [high[0] - low[0], high[1] - low[1], high[2] - low[2]] : [0, 0, 0];
  const triangles = enabled.reduce((n, p) => n + p.positions.length / 9, 0);
  if (triangles > LIMITS.triangles) errors.push(`The enabled parts have ${triangles.toLocaleString()} triangles; the limit is ${LIMITS.triangles.toLocaleString()}.`);
  const longest = Math.max(...dims);
  if (enabled.length && (longest < LIMITS.minLength || longest > LIMITS.maxLength))
    errors.push(`The model is ${longest.toFixed(2)} m long. Supported lengths are ${LIMITS.minLength}–${LIMITS.maxLength} m; check the units.`);
  for (const p of enabled) {
    const b = soupBounds([p.positions]);
    if (b.low[2] < 0.005) errors.push(`${p.name} reaches within 5 mm of the road. Raise the clearance.`);
  }
  const openParts = enabled.filter((p) => openEdges(p.positions) > 0).map((p) => p.name);
  if (openParts.length)
    warnings.push(`Open edges in ${openParts.length} part${openParts.length > 1 ? "s" : ""}. Small holes are tolerated by the solver's voxel vote; large openings fill or leak.`);
  if (enabled.length) {
    if (hasStl && (longest > 15 || longest < 0.5)) {
      for (const u of ["mm", "cm", "in", "m"] as Units[]) {
        const l = (longest * UNIT_SCALE[u]) / UNIT_SCALE.m;
        void l;
      }
      hints.push({ label: `Model is ${longest.toFixed(2)} m long: were the units millimetres?`, apply: { units: "mm" } });
    }
    if (dims[2] > 1.1 * dims[0]) hints.push({ label: "Taller than long: the up axis may be wrong.", apply: {} });
    if (dims[1] > 1.1 * dims[0]) hints.push({ label: "Wider than long: turn the model 90°.", apply: { turn: true } });
  }
  return {
    low,
    high,
    dimensions: dims,
    triangles,
    frontalArea: enabled.length ? frontalArea(enabled.map((p) => p.positions)) : 0,
    errors,
    warnings,
    openParts,
    hints,
  };
}
