// Stretched tensor-product Cartesian grid. Uniform spacing around the car and near wake,
// geometric growth toward the tunnel walls. Cell counts per axis are rounded up to a
// multiple of 2^(levels-1) so the pressure multigrid can coarsen by two on every level.

export interface Axis {
  /** Face coordinates, length n + 1. */
  faces: Float64Array;
  /** Cell centres, length n. */
  centers: Float64Array;
  /** Cell widths, length n. */
  widths: Float64Array;
  n: number;
}

export interface Grid {
  x: Axis;
  y: Axis;
  z: Axis;
  /** Spacing of the uniformly fine region around the car (before detail refinement). */
  h: number;
  /** Smallest cell width on any axis (detail zones are finer than h). */
  hmin?: number;
  cells: number;
}

/** A band of finer cells along one axis (detail refinement around small parts). */
export interface Band {
  lo: number;
  hi: number;
  h: number;
}

/** Growth ratio of cell widths leaving a detail band. */
export const BAND_GROWTH = 1.25;

/**
 * Widths filling [a, b] at spacing `hf`, finer inside `bands` with geometric transitions.
 * Marches with the local target size, then rescales to end exactly at b.
 */
function bandedWidths(a: number, b: number, hf: number, bands: Band[]): number[] {
  const g = BAND_GROWTH - 1;
  const target = (c: number) => {
    let t = hf;
    for (const band of bands) {
      const d = c < band.lo ? band.lo - c : c > band.hi ? c - band.hi : 0;
      t = Math.min(t, band.h + g * d);
    }
    return t;
  };
  const out: number[] = [];
  let pos = a;
  while (b - pos > 1e-12) {
    let w = target(pos);
    w = Math.min(w, target(pos + w));
    w = Math.min(w, target(pos + w));
    const rest = b - pos;
    if (rest < 1.5 * w) {
      if (rest < 0.5 * w && out.length) out[out.length - 1] += rest;
      else out.push(rest);
      break;
    }
    out.push(w);
    pos += w;
  }
  const sum = out.reduce((s, w) => s + w, 0);
  return out.map((w) => (w * (b - a)) / sum);
}

/** Merge overlapping or touching bands, keeping the finer spacing where they meet. */
export function mergeBands(bands: Band[]): Band[] {
  const sorted = [...bands].sort((p, q) => p.lo - q.lo);
  const out: Band[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.lo <= last.hi && Math.abs(b.h - last.h) < 1e-9 * last.h) last.hi = Math.max(last.hi, b.hi);
    else out.push({ ...b });
  }
  return out;
}

export interface AxisSpec {
  lo: number;
  hi: number;
  fineLo: number;
  fineHi: number;
  h: number;
  growthLo: number;
  growthHi: number;
  hmax: number;
}

function side(length: number, h: number, growth: number, hmax: number): number[] {
  // Spacings leaving the refined region, starting next to it.
  const out: number[] = [];
  let sum = 0;
  let s = h;
  while (sum < length - 1e-12) {
    s = Math.min(s * growth, hmax);
    const rest = length - sum;
    if (rest < 1.5 * s) {
      if (rest < 0.6 * s && out.length) out[out.length - 1] += rest;
      else out.push(rest);
      break;
    }
    out.push(s);
    sum += s;
  }
  return out;
}

export function buildAxis(spec: AxisSpec, multiple: number, extra?: { hi: number; h: number }, bands: Band[] = []): Axis {
  const fineLo = Math.max(spec.lo, spec.fineLo);
  const fineHi = Math.min(spec.hi, spec.fineHi);
  let widths: number[];
  const inside = bands
    .map((b) => ({ lo: Math.max(b.lo, fineLo), hi: Math.min(b.hi, fineHi), h: b.h }))
    .filter((b) => b.hi > b.lo && b.h < spec.h);
  if (inside.length) {
    // Detail bands: the fine region keeps spacing h except where a band asks for finer cells.
    // The road-clearance band becomes one more band.
    if (extra && extra.hi > fineLo) inside.push({ lo: fineLo, hi: extra.hi, h: extra.h });
    const nf = Math.max(1, Math.ceil((fineHi - fineLo) / spec.h - 1e-9));
    const hf = (fineHi - fineLo) / nf;
    const lower = side(fineLo - spec.lo, hf, spec.growthLo, spec.hmax).reverse();
    const upper = side(spec.hi - fineHi, hf, spec.growthHi, spec.hmax);
    widths = [...lower, ...bandedWidths(fineLo, fineHi, hf, mergeBands(inside)), ...upper];
  } else if (extra && extra.hi > fineLo && extra.hi < fineHi) {
    // Extra-fine band at the low end (road clearance), a short transition, then the fine region.
    const n2 = Math.max(2, Math.ceil((extra.hi - fineLo) / extra.h - 1e-9));
    const h2 = (extra.hi - fineLo) / n2;
    const trans: number[] = [];
    let w = h2, at = extra.hi;
    while (w * 1.3 < spec.h && at + w * 1.3 < fineHi) {
      w *= 1.3;
      trans.push(w);
      at += w;
    }
    const nf = Math.max(1, Math.ceil((fineHi - at) / spec.h - 1e-9));
    const hf = (fineHi - at) / nf;
    const upper = side(spec.hi - fineHi, hf, spec.growthHi, spec.hmax);
    widths = [...Array(n2).fill(h2), ...trans, ...Array(nf).fill(hf), ...upper];
  } else {
    const nf = Math.max(1, Math.ceil((fineHi - fineLo) / spec.h - 1e-9));
    const hf = (fineHi - fineLo) / nf;
    const lower = side(fineLo - spec.lo, hf, spec.growthLo, spec.hmax).reverse();
    const upper = side(spec.hi - fineHi, hf, spec.growthHi, spec.hmax);
    widths = [...lower, ...Array(nf).fill(hf), ...upper];
  }
  // Pad to a multiple by halving the widest cells, which sit in the far field.
  while (widths.length % multiple) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[widest] * (1 + 1e-9)) widest = i;
    const half = widths[widest] / 2;
    widths.splice(widest, 1, half, half);
  }
  const n = widths.length;
  const faces = new Float64Array(n + 1);
  faces[0] = spec.lo;
  for (let i = 0; i < n; i++) faces[i + 1] = faces[i] + widths[i];
  faces[n] = spec.hi;
  const centers = new Float64Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    centers[i] = 0.5 * (faces[i] + faces[i + 1]);
    w[i] = faces[i + 1] - faces[i];
  }
  return { faces, centers, widths: w, n };
}

export interface GridRequest {
  domain: [number, number, number, number, number, number];
  low: [number, number, number];
  high: [number, number, number];
  cellsPerLength: number;
  levels: number;
  /** Length of the uniformly fine region behind the car, in car lengths. */
  wakeLength?: number;
  /** Growth rate of cells downstream of that region. */
  wakeGrowth?: number;
  /** Shift of the grid lattice relative to the car, in cells (per axis), for alignment studies. */
  phase?: [number, number, number];
  /** Height up to which the road clearance gets half-size cells (0: off). */
  clearanceBand?: number;
  /** Detail refinement bands per axis (x, y, z). */
  bands?: [Band[], Band[], Band[]];
  /** Exact total Cartesian cell count for controlled resolution studies. */
  targetCells?: number;
  /** Far-field stretching and near-car extents for controlled mesh-allocation studies. */
  farGrowth?: number;
  farCellSize?: number;
  finePadding?: number;
  roofPadding?: number;
}

/** Factor a cell budget while preserving the original grid's aspect ratio. */
export function countsForCells(cells: number, shape: number[]): [number, number, number] {
  if (!Number.isSafeInteger(cells) || cells < 512) throw new Error("The cell count must be an integer of at least 512.");
  const scale = Math.cbrt(cells / (shape[0] * shape[1] * shape[2]));
  const wanted = shape.map(n => n * scale);
  let best: [number, number, number] | undefined, score = Infinity;
  for (let x = 8; x <= cells / 64; x++) {
    if (cells % x) continue;
    const yz = cells / x;
    for (let y = 8; y <= yz / 8; y++) {
      if (yz % y) continue;
      const z = yz / y;
      const error = Math.log(x / wanted[0]) ** 2 + Math.log(y / wanted[1]) ** 2 + Math.log(z / wanted[2]) ** 2;
      if (error < score) { score = error; best = [x, y, z]; }
    }
  }
  if (!best) throw new Error("The cell count cannot form a grid with at least eight cells on each axis.");
  return best;
}

/** Resample the stretched face coordinates, keeping both tunnel boundaries exact. */
function resizeAxis(a: Axis, n: number): Axis {
  if (n === a.n) return a;
  const faces = new Float64Array(n + 1), centers = new Float64Array(n), widths = new Float64Array(n);
  for (let i = 0; i <= n; i++) {
    const at = i * a.n / n, lo = Math.min(Math.floor(at), a.n - 1);
    faces[i] = a.faces[lo] + (at - lo) * (a.faces[lo + 1] - a.faces[lo]);
  }
  faces[n] = a.faces[a.n];
  for (let i = 0; i < n; i++) { centers[i] = (faces[i] + faces[i + 1]) / 2; widths[i] = faces[i + 1] - faces[i]; }
  return { n, faces, centers, widths };
}

export function buildGrid(req: GridRequest): Grid {
  const [x0, x1, y0, y1, , z1] = req.domain;
  const { low, high } = req;
  const L = high[0] - low[0];
  const W = high[1] - low[1];
  const H = high[2];
  const h = L / req.cellsPerLength;
  const hmax = Math.max((req.farCellSize ?? 1/6) * L, 4 * h);
  const multiple = 2 ** (req.levels - 1);
  const ph = req.phase ?? [0, 0, 0];
  let x = buildAxis(
    { lo: x0, hi: x1, fineLo: low[0] - (req.finePadding ?? 0.25) * L - ph[0] * h, fineHi: high[0] + (req.wakeLength ?? 0.8) * L - ph[0] * h, h, growthLo: req.farGrowth ?? 1.15, growthHi: req.wakeGrowth ?? req.farGrowth ?? 1.08, hmax },
    multiple,
    undefined,
    req.bands?.[0],
  );
  const pad = req.finePadding !== undefined ? req.finePadding * L : 0.15 * Math.max(W, 0.3 * L);
  let y = buildAxis(
    { lo: y0, hi: y1, fineLo: low[1] - pad - ph[1] * h, fineHi: high[1] + pad - ph[1] * h, h, growthLo: req.farGrowth ?? 1.15, growthHi: req.farGrowth ?? 1.15, hmax },
    multiple,
    undefined,
    req.bands?.[1],
  );
  let z = buildAxis(
    { lo: 0, hi: z1, fineLo: 0, fineHi: H + (req.roofPadding !== undefined ? req.roofPadding*L : 0.25 * Math.max(H, 0.2 * L)) + ph[2] * h, h, growthLo: req.farGrowth ?? 1.15, growthHi: req.farGrowth ?? 1.15, hmax },
    multiple,
    req.clearanceBand ? { hi: req.clearanceBand + ph[2] * 0.5 * h, h: 0.5 * h } : undefined,
    req.bands?.[2],
  );
  let baseH = h;
  if (req.targetCells !== undefined) {
    const oldCells = x.n * y.n * z.n;
    const counts = countsForCells(req.targetCells, [x.n, y.n, z.n]);
    [x, y, z] = [x, y, z].map((a, i) => resizeAxis(a, counts[i]));
    baseH *= Math.cbrt(oldCells / req.targetCells);
  }
  const hmin = Math.min(...[x, y, z].map((a) => Math.min(...a.widths)));
  return { x, y, z, h: baseH, hmin, cells: x.n * y.n * z.n };
}

/** Index of the cell containing coordinate c (clamped). */
export function locate(axis: Axis, c: number): number {
  const f = axis.faces;
  if (c <= f[0]) return 0;
  if (c >= f[axis.n]) return axis.n - 1;
  let lo = 0;
  let hi = axis.n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid] <= c) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Automatic tunnel: 3 lengths upstream, 6 downstream, 2 to each side and above (as in the OpenFOAM app). */
export function automaticDomain(
  low: [number, number, number],
  high: [number, number, number],
): [number, number, number, number, number, number] {
  const L = high[0] - low[0];
  return [low[0] - 3 * L, high[0] + 6 * L, low[1] - 2 * L, high[1] + 2 * L, 0, high[2] + 2 * L];
}
