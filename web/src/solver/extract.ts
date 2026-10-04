// Turns solver fields (stretched grid, staggered velocity) into what the visualisation needs:
// a uniform grid around the car and per-vertex surface values. Nothing here invents data: every
// value is interpolated from computed cells, and points without fluid neighbours are marked invalid.

import type { FlowFields } from "./gpu";
import { locate } from "./grid";
import type { CaseSetup } from "./setup";
import type { Vec3 } from "./types";

export interface VizField {
  origin: Vec3;
  spacing: Vec3;
  dims: [number, number, number];
  /** Cell-centred velocity (m/s), kinematic pressure (m²/s²), turbulent kinetic energy (m²/s²). */
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  p: Float32Array;
  k: Float32Array;
  /** 1 where the point is inside the car or has no fluid neighbour. */
  solid: Uint8Array;
  freestream: number;
  inlet: Vec3;
  length: number;
}

export interface SurfaceSample {
  /** Fluid traction on the wall, Pa. Never confused with near-wall velocity below. */
  wallStress?: Float32Array;
  stressValid?: Uint8Array;
  snapshot?: { iteration: number; grid: string; unit: "Pa"; dynamicPressure: number };
  /** Pressure coefficient per soup vertex (p / ½U²). */
  cp: Float32Array;
  /** Near-wall velocity direction per soup vertex (tangential, m/s), for surface flow lines. */
  shear: Float32Array;
}

/** Cell-centred velocity field from face velocities (interior cells, ghosted indexing). */
function cellVelocity(c: CaseSetup, f: FlowFields): { uc: Float32Array; vc: Float32Array; wc: Float32Array } {
  const { NX, NY, NC } = c;
  const uc = new Float32Array(NC), vc = new Float32Array(NC), wc = new Float32Array(NC);
  const vel = f.vel;
  for (let idx = NX * NY; idx < NC - NX * NY; idx++) {
    if (c.flags[idx] & 1) continue;
    uc[idx] = 0.5 * (vel[idx] + vel[idx - 1]);
    vc[idx] = 0.5 * (vel[NC + idx] + vel[NC + idx - NX]);
    wc[idx] = 0.5 * (vel[2 * NC + idx] + vel[2 * NC + idx - NX * NY]);
  }
  return { uc, vc, wc };
}

interface AxisWeights {
  i0: Int32Array;
  t: Float32Array;
}

/** For sample coordinates, the lower ghosted cell index and linear weight between cell centres. */
function axisWeights(centers: Float64Array, coords: number[]): AxisWeights {
  // centers: interior centres (length n); ghosted index = interior + 1
  const n = centers.length;
  const i0 = new Int32Array(coords.length);
  const t = new Float32Array(coords.length);
  let j = 0;
  coords.forEach((x, s) => {
    if (x <= centers[0]) {
      i0[s] = 1;
      t[s] = 0;
      return;
    }
    if (x >= centers[n - 1]) {
      i0[s] = n - 1;
      t[s] = 1;
      return;
    }
    while (j > 0 && centers[j] > x) j--;
    while (j < n - 2 && centers[j + 1] < x) j++;
    i0[s] = j + 1;
    t[s] = (x - centers[j]) / (centers[j + 1] - centers[j]);
  });
  return { i0, t };
}

export interface Sampler {
  /** `side` (point, unit normal): skip cells behind that plane. */
  sample(x: number, y: number, z: number, out: Float32Array, side?: Float64Array): boolean;
}

/** Trilinear interpolation using only fluid cells (weights renormalised). out = [u, v, w, p, k]. */
export function makeSampler(c: CaseSetup, f: FlowFields): Sampler {
  const { uc, vc, wc } = cellVelocity(c, f);
  const { NX, NY } = c;
  const { x, y, z } = c.grid;
  const locate = (centers: Float64Array, v: number): [number, number] => {
    const n = centers.length;
    if (v <= centers[0]) return [1, 0];
    if (v >= centers[n - 1]) return [n - 1, 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (centers[m] <= v) lo = m;
      else hi = m;
    }
    return [lo + 1, (v - centers[lo]) / (centers[lo + 1] - centers[lo])];
  };
  return {
    sample(px, py, pz, out, side) {
      const [i, tx] = locate(x.centers, px);
      const [j, ty] = locate(y.centers, py);
      const [k, tz] = locate(z.centers, pz);
      let wsum = 0;
      out.fill(0);
      for (let dk = 0; dk < 2; dk++)
        for (let dj = 0; dj < 2; dj++)
          for (let di = 0; di < 2; di++) {
            const idx = i + di + NX * (j + dj + NY * (k + dk));
            if (c.flags[idx] & 1) continue;
            // Surface samples use only cells on the surface's own side (thin walls have fluid on both).
            if (side && (x.centers[i + di - 1] - side[0]) * side[3] + (y.centers[j + dj - 1] - side[1]) * side[4] + (z.centers[k + dk - 1] - side[2]) * side[5] <= 0) continue;
            const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
            if (w <= 0) continue;
            wsum += w;
            out[0] += w * uc[idx];
            out[1] += w * vc[idx];
            out[2] += w * wc[idx];
            out[3] += w * f.pres[idx];
            out[4] += w * f.turb[idx];
          }
      if (wsum < 1e-6) return false;
      for (let m = 0; m < 5; m++) out[m] /= wsum;
      return true;
    },
  };
}

/** The visualisation window around a car (bounds low/high, length L) inside a tunnel domain. */
export function vizBoxFor(low: Vec3, high: Vec3, domain: number[], L: number): { low: Vec3; high: Vec3 } {
  const [x0, x1, y0, y1, , z1] = domain;
  const W = high[1] - low[1];
  return {
    low: [Math.max(x0, low[0] - 0.6 * L), Math.max(y0, low[1] - 0.25 * W - 0.25 * L), 0],
    high: [Math.min(x1, high[0] + 2.2 * L), Math.min(y1, high[1] + 0.25 * W + 0.25 * L), Math.min(z1, high[2] + 0.45 * L)],
  };
}

export function vizBox(c: CaseSetup): { low: Vec3; high: Vec3 } {
  return vizBoxFor(c.low, c.high, c.domain, c.length);
}

/** Uniform grid of about `target` points over a box (the layout every VizField uses). */
export function vizGrid(low: Vec3, high: Vec3, target: number): { origin: Vec3; spacing: Vec3; dims: [number, number, number] } {
  const ext: Vec3 = [high[0] - low[0], high[1] - low[1], high[2] - low[2]];
  const h = Math.cbrt((ext[0] * ext[1] * ext[2]) / target);
  const dims: [number, number, number] = [Math.max(8, Math.round(ext[0] / h)), Math.max(8, Math.round(ext[1] / h)), Math.max(8, Math.round(ext[2] / h))];
  const spacing: Vec3 = [ext[0] / (dims[0] - 1), ext[1] / (dims[1] - 1), ext[2] / (dims[2] - 1)];
  return { origin: low, spacing, dims };
}

/** Resample onto a uniform grid of about `target` points covering the car and near wake. */
export function extractViz(c: CaseSetup, f: FlowFields, target = 1_200_000): VizField {
  const { low, high } = vizBox(c);
  const { spacing, dims } = vizGrid(low, high, target);
  const n = dims[0] * dims[1] * dims[2];
  const out = {
    u: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n),
    p: new Float32Array(n), k: new Float32Array(n), solid: new Uint8Array(n),
  };
  const { uc, vc, wc } = cellVelocity(c, f);
  const ax = axisWeights(c.grid.x.centers, Array.from({ length: dims[0] }, (_, i) => low[0] + i * spacing[0]));
  const ay = axisWeights(c.grid.y.centers, Array.from({ length: dims[1] }, (_, i) => low[1] + i * spacing[1]));
  const az = axisWeights(c.grid.z.centers, Array.from({ length: dims[2] }, (_, i) => low[2] + i * spacing[2]));
  const { NX, NY } = c;
  let o = 0;
  for (let kk = 0; kk < dims[2]; kk++)
    for (let jj = 0; jj < dims[1]; jj++)
      for (let ii = 0; ii < dims[0]; ii++, o++) {
        const i = ax.i0[ii], j = ay.i0[jj], k = az.i0[kk];
        const tx = ax.t[ii], ty = ay.t[jj], tz = az.t[kk];
        // nearest cell decides solid
        const ni = i + (tx > 0.5 ? 1 : 0), nj = j + (ty > 0.5 ? 1 : 0), nk = k + (tz > 0.5 ? 1 : 0);
        if (c.flags[ni + NX * (nj + NY * nk)] & 1) {
          out.solid[o] = 1;
          continue;
        }
        let wsum = 0, su = 0, sv = 0, sw = 0, sp = 0, sk = 0;
        for (let dk = 0; dk < 2; dk++)
          for (let dj = 0; dj < 2; dj++)
            for (let di = 0; di < 2; di++) {
              const idx = i + di + NX * (j + dj + NY * (k + dk));
              if (c.flags[idx] & 1) continue;
              const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
              wsum += w;
              su += w * uc[idx];
              sv += w * vc[idx];
              sw += w * wc[idx];
              sp += w * f.pres[idx];
              sk += w * f.turb[idx];
            }
        if (wsum < 1e-6) {
          out.solid[o] = 1;
          continue;
        }
        out.u[o] = su / wsum;
        out.v[o] = sv / wsum;
        out.w[o] = sw / wsum;
        out.p[o] = sp / wsum;
        out.k[o] = sk / wsum;
      }
  return { origin: low, spacing, dims, ...out, freestream: c.freestream, inlet: c.inlet, length: c.length };
}

/**
 * Pressure coefficient and near-wall velocity at every vertex of a triangle soup. Each vertex is
 * sampled just outside the surface along its triangle's normal, from fluid cells only.
 */
export function sampleSurface(c: CaseSetup, sampler: Sampler, positions: Float32Array): SurfaceSample {
  const nv = positions.length / 3;
  const cp = new Float32Array(nv);
  const shear = new Float32Array(nv * 3);
  const q = 0.5 * c.freestream * c.freestream;
  const { x, y, z } = c.grid;
  const s = new Float32Array(5);
  const side = new Float64Array(6);
  for (let t = 0; t < nv / 3; t++) {
    const o = t * 9;
    const ax = positions[o + 3] - positions[o], ay = positions[o + 4] - positions[o + 1], az = positions[o + 5] - positions[o + 2];
    const bx = positions[o + 6] - positions[o], by = positions[o + 7] - positions[o + 1], bz = positions[o + 8] - positions[o + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let v = 0; v < 3; v++) {
      const px = positions[o + 3 * v], py = positions[o + 3 * v + 1], pz = positions[o + 3 * v + 2];
      // Offset in units of the local cell size along the normal (detail zones have smaller cells).
      const h = Math.abs(nx) * x.widths[locate(x, px)] + Math.abs(ny) * y.widths[locate(y, py)] + Math.abs(nz) * z.widths[locate(z, pz)];
      side.set([px, py, pz, nx, ny, nz]);
      let ok = false;
      for (const d of [0.9, 1.6, 2.5]) {
        if (sampler.sample(px + nx * d * h, py + ny * d * h, pz + nz * d * h, s, side)) {
          ok = true;
          break;
        }
      }
      const vi = t * 3 + v;
      if (!ok) {
        cp[vi] = NaN;
        continue;
      }
      cp[vi] = s[3] / q;
      const dot = s[0] * nx + s[1] * ny + s[2] * nz;
      shear[3 * vi] = s[0] - dot * nx;
      shear[3 * vi + 1] = s[1] - dot * ny;
      shear[3 * vi + 2] = s[2] - dot * nz;
    }
  }
  return { cp, shear };
}
