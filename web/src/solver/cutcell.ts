// Cut-cell geometry: signed distance at grid nodes → fluid volume fraction per cell and open
// area fraction per face. Sloped and curved surfaces are then seen by the flow as smooth walls
// instead of stair steps. The node sign comes from the same three-axis parity vote as the voxel
// mask; the magnitude is the exact distance to the nearest triangle inside a narrow band.

import { locate, type Axis, type Grid } from "./grid";

function nodeAxis(a: Axis): Axis {
  // Pseudo-axis whose "cells" are the grid nodes (face coordinates), so the ray caster can be reused.
  const n = a.n + 1;
  const centers = Float64Array.from(a.faces);
  const faces = new Float64Array(n + 1);
  faces[0] = centers[0] - 0.5 * (centers[1] - centers[0]);
  for (let i = 1; i < n; i++) faces[i] = 0.5 * (centers[i - 1] + centers[i]);
  faces[n] = centers[n - 1] + 0.5 * (centers[n - 1] - centers[n - 2]);
  const widths = new Float64Array(n);
  for (let i = 0; i < n; i++) widths[i] = faces[i + 1] - faces[i];
  return { faces, centers, widths, n };
}

export function nodeGrid(g: Grid): Grid {
  const x = nodeAxis(g.x), y = nodeAxis(g.y), z = nodeAxis(g.z);
  return { x, y, z, h: g.h, cells: x.n * y.n * z.n };
}

function pointTriangleDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  // Ericson, Real-Time Collision Detection, closest point on triangle.
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Unsigned distance from every node within `band` of the surface to the nearest triangle, and the
 * part owning that triangle. Nodes farther away keep `band` and part 255.
 */
export function nodeDistance(ng: Grid, parts: { positions: Float32Array }[], band: number): { dist: Float32Array; part: Uint8Array } {
  const { x, y, z } = ng;
  const nx = x.n, nxy = x.n * y.n;
  const dist = new Float32Array(ng.cells).fill(band);
  const part = new Uint8Array(ng.cells).fill(255);
  const d2 = new Float32Array(ng.cells).fill(band * band);
  const range = (a: Axis, lo: number, hi: number): [number, number] => {
    let i0 = locate(a, lo);
    if (a.centers[i0] < lo) i0++;
    let i1 = locate(a, hi);
    if (a.centers[i1] > hi) i1--;
    return [i0, i1];
  };
  parts.forEach((p, pi) => {
    const t = p.positions;
    for (let o = 0; o < t.length; o += 9) {
      const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
      const [i0, i1] = range(x, Math.min(ax, bx, cx) - band, Math.max(ax, bx, cx) + band);
      const [j0, j1] = range(y, Math.min(ay, by, cy) - band, Math.max(ay, by, cy) + band);
      const [k0, k1] = range(z, Math.min(az, bz, cz) - band, Math.max(az, bz, cz) + band);
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const n = i + nx * j + nxy * k;
            const d = pointTriangleDist2(x.centers[i], y.centers[j], z.centers[k], ax, ay, az, bx, by, bz, cx, cy, cz);
            if (d < d2[n]) {
              d2[n] = d;
              part[n] = pi;
            }
          }
    }
  });
  for (let n = 0; n < ng.cells; n++) dist[n] = Math.sqrt(d2[n]);
  return { dist, part };
}

export interface Fractions {
  /** Signed-distance interpolation at the fluid-volume centroid, when requested. */
  centroidWallDistance?: Float32Array;
  /** Fluid volume fraction per interior cell. */
  theta: Float32Array;
  /** Open area fraction of the +x, +y, +z face of each interior cell. */
  ax: Float32Array;
  ay: Float32Array;
  az: Float32Array;
  /** Part owning the nearest surface, per cell (255 none). */
  part: Uint8Array;
}

const FACE_SAMPLES = 16;
const CELL_SAMPLES = 8;

/** Fractions from signed node distances (negative inside). */
export function fractions(g: Grid, sdf: Float32Array, nodePart: Uint8Array, centroids = false): Fractions {
  const nx = g.x.n, ny = g.y.n, nz = g.z.n;
  const Nx = nx + 1, Nxy = (nx + 1) * (ny + 1);
  const cells = nx * ny * nz;
  const theta = new Float32Array(cells);
  const ax = new Float32Array(cells), ay = new Float32Array(cells), az = new Float32Array(cells);
  const part = new Uint8Array(cells).fill(255);
  const centroidWallDistance = centroids ? new Float32Array(cells) : undefined;
  const node = (i: number, j: number, k: number) => sdf[i + Nx * j + Nxy * k];
  // Fraction of a bilinear patch (corner values a,b,c,d at (0,0),(1,0),(0,1),(1,1)) above zero.
  const faceFrac = (a: number, b: number, c: number, d: number) => {
    if (a > 0 && b > 0 && c > 0 && d > 0) return 1;
    if (a <= 0 && b <= 0 && c <= 0 && d <= 0) return 0;
    let n = 0;
    for (let s = 0; s < FACE_SAMPLES; s++) {
      const u = (s + 0.5) / FACE_SAMPLES;
      for (let r = 0; r < FACE_SAMPLES; r++) {
        const v = (r + 0.5) / FACE_SAMPLES;
        const f = (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
        if (f > 0) n++;
      }
    }
    return n / (FACE_SAMPLES * FACE_SAMPLES);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        const s000 = node(i, j, k), s100 = node(i + 1, j, k), s010 = node(i, j + 1, k), s110 = node(i + 1, j + 1, k);
        const s001 = node(i, j, k + 1), s101 = node(i + 1, j, k + 1), s011 = node(i, j + 1, k + 1), s111 = node(i + 1, j + 1, k + 1);
        const all = [s000, s100, s010, s110, s001, s101, s011, s111];
        const pos = all.filter((v) => v > 0).length;
        if (pos === 8) theta[c] = 1;
        else if (pos === 0) theta[c] = 0;
        else {
          let n = 0;
          let sx = 0, sy = 0, sz = 0;
          for (let a = 0; a < CELL_SAMPLES; a++) {
            const w = (a + 0.5) / CELL_SAMPLES;
            for (let b = 0; b < CELL_SAMPLES; b++) {
              const v = (b + 0.5) / CELL_SAMPLES;
              for (let e = 0; e < CELL_SAMPLES; e++) {
                const u = (e + 0.5) / CELL_SAMPLES;
                const f =
                  (1 - w) * ((1 - v) * ((1 - u) * s000 + u * s100) + v * ((1 - u) * s010 + u * s110)) +
                  w * ((1 - v) * ((1 - u) * s001 + u * s101) + v * ((1 - u) * s011 + u * s111));
                if (f > 0) { n++; if (centroids) { sx += u; sy += v; sz += w; } }
              }
            }
          }
          theta[c] = n / CELL_SAMPLES ** 3;
          if (centroidWallDistance && n) {
            const u = sx/n, v = sy/n, w = sz/n;
            centroidWallDistance[c] = (1-w)*((1-v)*((1-u)*s000+u*s100)+v*((1-u)*s010+u*s110)) + w*((1-v)*((1-u)*s001+u*s101)+v*((1-u)*s011+u*s111));
          }
        }
        // +x face: nodes (i+1, j..j+1, k..k+1); +y: (i..i+1, j+1, k..); +z: (i.., j.., k+1)
        ax[c] = faceFrac(s100, s110, s101, s111);
        ay[c] = faceFrac(s010, s110, s011, s111);
        az[c] = faceFrac(s001, s101, s011, s111);
        // owner of the nearest surface: corner with the smallest |sdf|
        let best = Infinity;
        const corners = [
          [i, j, k], [i + 1, j, k], [i, j + 1, k], [i + 1, j + 1, k],
          [i, j, k + 1], [i + 1, j, k + 1], [i, j + 1, k + 1], [i + 1, j + 1, k + 1],
        ];
        for (let q = 0; q < 8; q++) {
          const [a, b, e] = corners[q];
          const n = a + Nx * b + Nxy * e;
          const v = Math.abs(all[q]);
          if (v < best && nodePart[n] !== 255) {
            best = v;
            part[c] = nodePart[n];
          }
        }
      }
  return { theta, ax, ay, az, part, centroidWallDistance };
}

function segmentHitsTriangle(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  t: Float32Array, o: number,
): boolean {
  // Möller–Trumbore, segment parameter in [0, 1].
  const e1x = t[o + 3] - t[o], e1y = t[o + 4] - t[o + 1], e1z = t[o + 5] - t[o + 2];
  const e2x = t[o + 6] - t[o], e2y = t[o + 7] - t[o + 1], e2z = t[o + 8] - t[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const sx = ox - t[o], sy = oy - t[o + 1], sz = oz - t[o + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s >= 0 && s <= 1;
}

/**
 * Thin parts (wings, splitters, endplates) as zero-thickness walls: every face whose centre-to-centre
 * segment crosses one of the part's triangles is closed. Cells beside a closed face take the part
 * as their wall owner. Returns the number of faces closed.
 */
export function closeThinFaces(
  g: Grid, tri: Float32Array, part: number,
  ax: Float32Array, ay: Float32Array, az: Float32Array, owner: Uint8Array,
): number {
  const { x, y, z } = g;
  const nx = x.n, ny = y.n, nz = z.n;
  let closed = 0;
  const range = (a: Axis, lo: number, hi: number): [number, number] => [Math.max(0, locate(a, lo) - 1), Math.min(a.n - 1, locate(a, hi) + 1)];
  for (let o = 0; o < tri.length; o += 9) {
    const [i0, i1] = range(x, Math.min(tri[o], tri[o + 3], tri[o + 6]), Math.max(tri[o], tri[o + 3], tri[o + 6]));
    const [j0, j1] = range(y, Math.min(tri[o + 1], tri[o + 4], tri[o + 7]), Math.max(tri[o + 1], tri[o + 4], tri[o + 7]));
    const [k0, k1] = range(z, Math.min(tri[o + 2], tri[o + 5], tri[o + 8]), Math.max(tri[o + 2], tri[o + 5], tri[o + 8]));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = i + nx * (j + ny * k);
          const px = x.centers[i], py = y.centers[j], pz = z.centers[k];
          if (i < nx - 1 && ax[c] > 0 && segmentHitsTriangle(px, py, pz, x.centers[i + 1] - px, 0, 0, tri, o)) {
            ax[c] = 0; owner[c] = owner[c + 1] = part; closed++;
          }
          if (j < ny - 1 && ay[c] > 0 && segmentHitsTriangle(px, py, pz, 0, y.centers[j + 1] - py, 0, tri, o)) {
            ay[c] = 0; owner[c] = owner[c + nx] = part; closed++;
          }
          if (k < nz - 1 && az[c] > 0 && segmentHitsTriangle(px, py, pz, 0, 0, z.centers[k + 1] - pz, tri, o)) {
            az[c] = 0; owner[c] = owner[c + nx * ny] = part; closed++;
          }
        }
  }
  return closed;
}
