// Geometry to solid mask. Each part is ray-cast along X, Y and Z through cell centres; a cell
// is solid when at least two of the three parity tests put its centre inside. The vote keeps
// a single missing triangle or small crack from filling a whole row of cells.
// Parts too thin to contain any cell centre (wings, splitters) are rasterised as a surface layer.

import { locate, type Axis, type Grid } from "./grid";

interface Hits {
  ray: Int32Array;
  at: Float32Array;
  n: number;
}

function grow(h: Hits) {
  const ray = new Int32Array(h.ray.length * 2);
  const at = new Float32Array(h.at.length * 2);
  ray.set(h.ray);
  at.set(h.at);
  h.ray = ray;
  h.at = at;
}

function span(axis: Axis, lo: number, hi: number): [number, number] {
  // Cell centres inside [lo, hi].
  const c = axis.centers;
  let a = locate(axis, lo);
  if (c[a] < lo) a++;
  let b = locate(axis, hi);
  if (c[b] > hi) b--;
  return [a, b];
}

/**
 * Cast rays along axis `a` (0 x, 1 y, 2 z). Rays pass through the centres of the other two axes.
 * Returns per-cell parity (1 inside).
 */
function castAxis(grid: Grid, tri: Float32Array, a: number, out: Uint8Array, jitter: number) {
  const axes = [grid.x, grid.y, grid.z];
  const b = (a + 1) % 3;
  const c = (a + 2) % 3;
  const A = axes[a];
  const B = axes[b];
  const C = axes[c];
  const hits: Hits = { ray: new Int32Array(1 << 16), at: new Float32Array(1 << 16), n: 0 };
  // Irrational offsets keep rays off shared edges and vertices of axis-aligned input.
  const jb = jitter * 0.7548776662;
  const jc = jitter * 0.5698402909;
  const count = tri.length / 9;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const pb0 = tri[o + b], pc0 = tri[o + c], pa0 = tri[o + a];
    const pb1 = tri[o + 3 + b], pc1 = tri[o + 3 + c], pa1 = tri[o + 3 + a];
    const pb2 = tri[o + 6 + b], pc2 = tri[o + 6 + c], pa2 = tri[o + 6 + a];
    const area = (pb1 - pb0) * (pc2 - pc0) - (pb2 - pb0) * (pc1 - pc0);
    if (Math.abs(area) < 1e-18) continue;
    const [bl, bh] = span(B, Math.min(pb0, pb1, pb2) - jb, Math.max(pb0, pb1, pb2) - jb);
    const [cl, ch] = span(C, Math.min(pc0, pc1, pc2) - jc, Math.max(pc0, pc1, pc2) - jc);
    for (let jc2 = cl; jc2 <= ch; jc2++) {
      const qc = C.centers[jc2] + jc;
      for (let jb2 = bl; jb2 <= bh; jb2++) {
        const qb = B.centers[jb2] + jb;
        const w0 = (pb1 - qb) * (pc2 - qc) - (pb2 - qb) * (pc1 - qc);
        const w1 = (pb2 - qb) * (pc0 - qc) - (pb0 - qb) * (pc2 - qc);
        const w2 = (pb0 - qb) * (pc1 - qc) - (pb1 - qb) * (pc0 - qc);
        const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
        if (!inside) continue;
        const at = (w0 * pa0 + w1 * pa1 + w2 * pa2) / area;
        if (hits.n === hits.ray.length) grow(hits);
        hits.ray[hits.n] = jb2 + B.n * jc2;
        hits.at[hits.n] = at;
        hits.n++;
      }
    }
  }
  // Counting sort by ray.
  const rays = B.n * C.n;
  const start = new Int32Array(rays + 1);
  for (let i = 0; i < hits.n; i++) start[hits.ray[i] + 1]++;
  for (let r = 0; r < rays; r++) start[r + 1] += start[r];
  const sorted = new Float32Array(hits.n);
  const fill = start.slice(0, rays);
  for (let i = 0; i < hits.n; i++) sorted[fill[hits.ray[i]]++] = hits.at[i];
  const stride = [1, grid.x.n, grid.x.n * grid.y.n];
  for (let r = 0; r < rays; r++) {
    const s = start[r];
    const e = start[r + 1];
    if (e - s < 2) continue;
    const list = Array.from(sorted.subarray(s, e)).sort((p, q) => p - q);
    const jb2 = r % B.n;
    const jc2 = (r / B.n) | 0;
    const base = jb2 * stride[b] + jc2 * stride[c];
    for (let m = 0; m + 1 < list.length; m += 2) {
      const [i0, i1] = span(A, list[m], list[m + 1]);
      for (let i = i0; i <= i1; i++) out[base + i * stride[a]]++;
    }
  }
}

export function meshVolumeArea(tri: Float32Array): { volume: number; area: number } {
  let volume = 0;
  let area = 0;
  for (let o = 0; o < tri.length; o += 9) {
    const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
    const bx = tri[o + 3] - ax, by = tri[o + 4] - ay, bz = tri[o + 5] - az;
    const cx = tri[o + 6] - ax, cy = tri[o + 7] - ay, cz = tri[o + 8] - az;
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    area += 0.5 * Math.hypot(nx, ny, nz);
    volume += (ax * nx + ay * ny + az * nz) / 6;
  }
  return { volume, area };
}

function rasteriseSurface(grid: Grid, tri: Float32Array, label: number, solid: Uint8Array) {
  const step = 0.4 * grid.h;
  const nx = grid.x.n, nxy = grid.x.n * grid.y.n;
  for (let o = 0; o < tri.length; o += 9) {
    const e1 = Math.hypot(tri[o + 3] - tri[o], tri[o + 4] - tri[o + 1], tri[o + 5] - tri[o + 2]);
    const e2 = Math.hypot(tri[o + 6] - tri[o], tri[o + 7] - tri[o + 1], tri[o + 8] - tri[o + 2]);
    const e3 = Math.hypot(tri[o + 6] - tri[o + 3], tri[o + 7] - tri[o + 4], tri[o + 8] - tri[o + 5]);
    const n = Math.max(1, Math.ceil(Math.max(e1, e2, e3) / step));
    for (let a = 0; a <= n; a++)
      for (let b = 0; a + b <= n; b++) {
        const u = a / n, v = b / n, w = 1 - u - v;
        const px = w * tri[o] + u * tri[o + 3] + v * tri[o + 6];
        const py = w * tri[o + 1] + u * tri[o + 4] + v * tri[o + 7];
        const pz = w * tri[o + 2] + u * tri[o + 5] + v * tri[o + 8];
        const idx = locate(grid.x, px) + nx * locate(grid.y, py) + nxy * locate(grid.z, pz);
        if (!solid[idx]) solid[idx] = label;
      }
  }
}

export interface VoxelResult {
  /** 0 fluid, otherwise part index + 1. Interior cells only, x fastest. */
  solid: Uint8Array;
  thinParts: number[];
  partCells: number[];
}

export function voxelize(grid: Grid, parts: { positions: Float32Array }[], detectThin = true): VoxelResult {
  const cells = grid.cells;
  const solid = new Uint8Array(cells);
  const votes = new Uint8Array(cells);
  const thinParts: number[] = [];
  const partCells: number[] = [];
  const cellVolume = grid.h ** 3;
  parts.forEach((part, p) => {
    votes.fill(0);
    for (let a = 0; a < 3; a++) castAxis(grid, part.positions, a, votes, grid.h * 1e-3);
    let count = 0;
    for (let i = 0; i < cells; i++)
      if (votes[i] >= 2) {
        if (!solid[i]) solid[i] = p + 1;
        count++;
      }
    const { volume, area } = meshVolumeArea(part.positions);
    const thickness = area > 0 ? (2 * Math.abs(volume)) / area : 0;
    if (detectThin && (thickness < 1.5 * grid.h || count * cellVolume < 0.5 * Math.abs(volume))) {
      thinParts.push(p);
      rasteriseSurface(grid, part.positions, p + 1, solid);
      count = 0;
      for (let i = 0; i < cells; i++) if (solid[i] === p + 1) count++;
    }
    partCells.push(count);
  });
  return { solid, thinParts, partCells };
}

// Exact squared Euclidean distance transform on a non-uniform grid (Felzenszwalb & Huttenlocher),
// separable along each axis. Sites are solid cell centres.
function edt1d(f: Float64Array, pos: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let s: number;
    for (;;) {
      const p = v[k];
      s = (f[q] + pos[q] * pos[q] - (f[p] + pos[p] * pos[p])) / (2 * (pos[q] - pos[p]));
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) {
      v[k] = q;
      z[k + 1] = Infinity;
    } else {
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
  }
  if (k < 0) {
    d.fill(Infinity, 0, n);
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < pos[q]) j++;
    const dq = pos[q] - pos[v[j]];
    d[q] = dq * dq + f[v[j]];
  }
}

/** Distance from each cell centre to the nearest wall (car surface or road). */
export function wallDistance(grid: Grid, solid: Uint8Array): Float32Array {
  const { x, y, z } = grid;
  const nx = x.n, ny = y.n, nz = z.n;
  const dist = new Float64Array(grid.cells);
  for (let i = 0; i < grid.cells; i++) dist[i] = solid[i] ? 0 : Infinity;
  const nmax = Math.max(nx, ny, nz);
  const f = new Float64Array(nmax), d = new Float64Array(nmax), v = new Int32Array(nmax), zz = new Float64Array(nmax + 1);
  const pass = (axis: Axis, stride: number, outer: [number, number, number, number]) => {
    const [n1, s1, n2, s2] = outer;
    for (let b = 0; b < n2; b++)
      for (let a = 0; a < n1; a++) {
        const base = a * s1 + b * s2;
        for (let i = 0; i < axis.n; i++) f[i] = dist[base + i * stride];
        edt1d(f, axis.centers, axis.n, d, v, zz);
        for (let i = 0; i < axis.n; i++) dist[base + i * stride] = d[i];
      }
  };
  pass(x, 1, [ny, nx, nz, nx * ny]);
  pass(y, nx, [nx, 1, nz, nx * ny]);
  pass(z, nx * ny, [nx, 1, ny, nx]);
  const out = new Float32Array(grid.cells);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * (j + ny * k);
        const hmin = Math.min(x.widths[i], y.widths[j], z.widths[k]);
        const body = Math.max(Math.sqrt(dist[idx]) - 0.5 * hmin, 0.5 * hmin);
        out[idx] = Math.min(body, z.centers[k]);
      }
  return out;
}
