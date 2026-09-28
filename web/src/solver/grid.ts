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
  /** Smallest spacing in the refined region. */
  h: number;
  cells: number;
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

export function buildAxis(spec: AxisSpec, multiple: number, extra?: { hi: number; h: number }): Axis {
  const fineLo = Math.max(spec.lo, spec.fineLo);
  const fineHi = Math.min(spec.hi, spec.fineHi);
  let widths: number[];
  if (extra && extra.hi > fineLo && extra.hi < fineHi) {
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
}

export function buildGrid(req: GridRequest): Grid {
  const [x0, x1, y0, y1, , z1] = req.domain;
  const { low, high } = req;
  const L = high[0] - low[0];
  const W = high[1] - low[1];
  const H = high[2];
  const h = L / req.cellsPerLength;
  const hmax = Math.max(L / 6, 4 * h);
  const multiple = 2 ** (req.levels - 1);
  const ph = req.phase ?? [0, 0, 0];
  const x = buildAxis(
    { lo: x0, hi: x1, fineLo: low[0] - 0.25 * L - ph[0] * h, fineHi: high[0] + (req.wakeLength ?? 0.8) * L - ph[0] * h, h, growthLo: 1.15, growthHi: req.wakeGrowth ?? 1.08, hmax },
    multiple,
  );
  const pad = 0.15 * Math.max(W, 0.3 * L);
  const y = buildAxis(
    { lo: y0, hi: y1, fineLo: low[1] - pad - ph[1] * h, fineHi: high[1] + pad - ph[1] * h, h, growthLo: 1.15, growthHi: 1.15, hmax },
    multiple,
  );
  const z = buildAxis(
    { lo: 0, hi: z1, fineLo: 0, fineHi: H + 0.25 * Math.max(H, 0.2 * L) + ph[2] * h, h, growthLo: 1.15, growthHi: 1.15, hmax },
    multiple,
    req.clearanceBand ? { hi: req.clearanceBand + ph[2] * 0.5 * h, h: 0.5 * h } : undefined,
  );
  return { x, y, z, h, cells: x.n * y.n * z.n };
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
