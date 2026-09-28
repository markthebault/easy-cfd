// CPU preprocessing: everything the GPU kernels need, as flat typed arrays.

import { automaticDomain, buildGrid, type Axis, type Grid } from "./grid";
import { meshVolumeArea, voxelize, wallDistance } from "./voxelize";
import { closeThinFaces, fractions, nodeDistance, nodeGrid } from "./cutcell";
import { NU, resolvePreset, type ExperimentalSettings, type Settings, type SolverPart, type Vec3 } from "./types";

export const MG_LEVELS = 5;
export const MAX_PARTS = 64;
/** Lower bound of the fluid fraction used in explicit updates of cut cells. */
export const THETA_EFF = 0.5;
/**
 * Scale ∇p by θ/θeff in cut cells (exact FAVOR steady state) or not (bounded pressure in slivers).
 * Unscaled keeps sliver cells from developing spurious suction peaks.
 */
export const SCALE_PRESSURE = false;
/** Cells with a smaller fluid fraction are merged with their most open neighbour for pressure. */
export const THETA_MERGE = 0.5;
/** Conductance multiplier of the link face between a merged cell and its master. */
export const MERGE_BOOST = 40;
/** Cells with less fluid than this become solid (removes slivers and junk pockets in narrow gaps). */
export const THETA_MIN = 0.05;
/** Default wall treatment: "k" (OpenFOAM nutk/omega wall functions) or "log" (equilibrium log law). */
export const WALL_MODEL: "k" | "log" = "k";
/** Thin parts: "wall" (zero-thickness closed faces) or "dilate" (smooth plate, at least THIN_MIN_CELLS thick). */
export const THIN_MODE: "wall" | "dilate" = "wall";
export const THIN_MIN_CELLS = 1.2;
/** Refine the road clearance (half-size vertical cells under the car). */
export const CLEARANCE_BAND = false;

export interface Level {
  nx: number;
  ny: number;
  nz: number;
  /** Ghosted sizes. */
  NX: number;
  NY: number;
  NZ: number;
  NC: number;
  /** vec4 per cell: conductance of +x, +y, +z faces and fixed-pressure boundary term. */
  coef: Float32Array;
}

export interface CaseSetup {
  /** Set by the preparation worker to pair fields with the grid they belong to. */
  caseKey?: number;
  grid: Grid;
  NX: number;
  NY: number;
  NZ: number;
  NC: number;
  gridBuffer: Float32Array;
  goff: [number, number, number, number];
  flags: Uint32Array;
  wallDist: Float32Array;
  levels: Level[];
  /** Wall cells for force integration: (ghosted cell, part | wheel << 16). */
  faces: Uint32Array;
  faceCount: number;
  /** Per ghosted cell: open fraction of the +x, +y, +z faces and fluid volume fraction θ. */
  aper: Float32Array;
  /** Per ghosted cell: wall area vector (into the solid, m²) and wall distance of the fluid centroid. */
  wall: Float32Array;
  parts: Float32Array;
  partIsWheel: boolean[];
  inlet: Vec3;
  groundSpeed: number;
  kIn: number;
  omegaIn: number;
  sideMode: number;
  speed: number;
  freestream: number;
  length: number;
  low: Vec3;
  high: Vec3;
  domain: [number, number, number, number, number, number];
  solidCells: number;
  fluidCells: number;
  /** Sliver cells merged with a neighbour for pressure. */
  mergedCells: number;
  wallModel: "k" | "log";
  mergeBoost: number;
  /** Momentum convection limiter: 0 van Leer, 1 minmod, 2 upwind. */
  limiter: number;
  /** Road-contact area closed with pressure-only faces (m²). */
  contactArea: number;
  /** Level-0 ingredients for rebuilding the pressure hierarchy with local time-step factors. */
  base: { x: Axis; y: Axis; z: Axis; openX: Float32Array; openY: Float32Array; openZ: Float32Array; fluid: Uint8Array; sideMode: number };
  thinParts: string[];
  sealedCells: number;
  /** Projected frontal area of the voxelised car (m²). */
  voxelFrontalArea: number;
  timings: Record<string, number>;
}

export function boundsOf(parts: SolverPart[]): { low: Vec3; high: Vec3 } {
  const low: Vec3 = [Infinity, Infinity, Infinity];
  const high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3)
      for (let c = 0; c < 3; c++) {
        const v = a[i + c];
        if (v < low[c]) low[c] = v;
        if (v > high[c]) high[c] = v;
      }
  }
  return { low, high };
}

export function domainFor(settings: Settings, low: Vec3, high: Vec3): [number, number, number, number, number, number] {
  const b = settings.simulation_box;
  if (b) return [b.x_min, b.x_max, b.y_min, b.y_max, 0, b.z_max];
  return automaticDomain(low, high);
}

export function validateDomain(domain: number[], low: Vec3, high: Vec3): string | null {
  const [x0, x1, y0, y1, , z1] = domain;
  if (!(x0 < low[0] && x1 > high[0] && y0 < low[1] && y1 > high[1] && z1 > high[2]))
    return "The simulation box must surround the car with space at the inlet, outlet, sides and top. The floor stays at Z = 0.";
  if (low[2] <= 0) return "The car must sit above the road (Z > 0).";
  return null;
}

function ghostAxis(a: Axis): { centers: Float64Array; widths: Float64Array } {
  const n = a.n;
  const centers = new Float64Array(n + 2);
  const widths = new Float64Array(n + 2);
  for (let i = 0; i < n; i++) {
    centers[i + 1] = a.centers[i];
    widths[i + 1] = a.widths[i];
  }
  widths[0] = a.widths[0];
  widths[n + 1] = a.widths[n - 1];
  centers[0] = a.faces[0] - 0.5 * widths[0];
  centers[n + 1] = a.faces[n] + 0.5 * widths[n + 1];
  return { centers, widths };
}

/** Conductances for a level from per-face open fractions (1 open, 0 blocked, fractional when coarsened). */
function levelCoef(
  x: Axis,
  y: Axis,
  z: Axis,
  openX: Float32Array,
  openY: Float32Array,
  openZ: Float32Array,
  fluid: Uint8Array,
  sideMode: number,
): Level {
  const nx = x.n, ny = y.n, nz = z.n;
  const NX = nx + 2, NY = ny + 2, NZ = nz + 2, NC = NX * NY * NZ;
  const coef = new Float32Array(NC * 4);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!fluid[c]) continue;
        const g = i + 1 + NX * (j + 1 + NY * (k + 1));
        const ax = y.widths[j] * z.widths[k];
        const ay = x.widths[i] * z.widths[k];
        const az = x.widths[i] * y.widths[j];
        if (i < nx - 1) coef[4 * g] = (openX[c] * ax) / (x.centers[i + 1] - x.centers[i]);
        if (j < ny - 1) coef[4 * g + 1] = (openY[c] * ay) / (y.centers[j + 1] - y.centers[j]);
        if (k < nz - 1) coef[4 * g + 2] = (openZ[c] * az) / (z.centers[k + 1] - z.centers[k]);
        let extra = 0;
        if (i === nx - 1) extra += ax / (0.5 * x.widths[i]);
        if (j === 0 && sideMode !== 1) extra += ay / (0.5 * y.widths[j]);
        if (j === ny - 1 && sideMode !== 2) extra += ay / (0.5 * y.widths[j]);
        coef[4 * g + 3] = extra;
      }
  return { nx, ny, nz, NX, NY, NZ, NC, coef };
}

function galerkin(f: Level): Level {
  const nx = f.nx / 2, ny = f.ny / 2, nz = f.nz / 2;
  const NX = nx + 2, NY = ny + 2, NZ = nz + 2, NC = NX * NY * NZ;
  const coef = new Float32Array(NC * 4);
  for (let K = 1; K <= nz; K++)
    for (let J = 1; J <= ny; J++)
      for (let I = 1; I <= nx; I++) {
        const C = I + NX * (J + NY * K);
        let gx = 0, gy = 0, gz = 0, extra = 0;
        for (let dk = 0; dk < 2; dk++)
          for (let dj = 0; dj < 2; dj++)
            for (let di = 0; di < 2; di++) {
              const i = 2 * I - 1 + di, j = 2 * J - 1 + dj, k = 2 * K - 1 + dk;
              const g = 4 * (i + f.NX * (j + f.NY * k));
              if (di === 1 && I < nx) gx += f.coef[g];
              if (dj === 1 && J < ny) gy += f.coef[g + 1];
              if (dk === 1 && K < nz) gz += f.coef[g + 2];
              extra += f.coef[g + 3];
            }
        coef.set([gx, gy, gz, extra], 4 * C);
      }
  return { nx, ny, nz, NX, NY, NZ, NC, coef };
}

/**
 * Pressure hierarchy for local time stepping: face conductances scaled by the face time-step factor
 * min(f_P, f_N), where f is the per-cell step relative to the reference step (ghosted array).
 */
export function scaledLevels(c: CaseSetup, fac: Float32Array): Level[] {
  const { x, y, z, openX, openY, openZ, fluid, sideMode } = c.base;
  const nx = x.n, ny = y.n, nz = z.n;
  const NX = nx + 2, NY = ny + 2;
  const sx = new Float32Array(openX.length), sy = new Float32Array(openY.length), sz = new Float32Array(openZ.length);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const cI = i + nx * (j + ny * k);
        const g = i + 1 + NX * (j + 1 + NY * (k + 1));
        const f = fac[g];
        sx[cI] = openX[cI] * Math.min(f, fac[g + 1]);
        sy[cI] = openY[cI] * Math.min(f, fac[g + NX]);
        sz[cI] = openZ[cI] * Math.min(f, fac[g + NX * NY]);
      }
  const lv = levelCoef(x, y, z, sx, sy, sz, fluid, sideMode);
  // Dirichlet boundary terms scale with the boundary cell's own factor.
  for (let g = 0; g < lv.NC; g++) lv.coef[4 * g + 3] *= fac[g];
  const levels = [lv];
  for (let l = 1; l < c.levels.length; l++) levels.push(galerkin(levels[l - 1]));
  return levels;
}

export function prepareCase(allParts: SolverPart[], settings: Settings): CaseSetup {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const parts = allParts.slice(0, MAX_PARTS);
  const { low, high } = boundsOf(parts);
  const length = high[0] - low[0];
  const domain = domainFor(settings, low, high);
  const problem = validateDomain(domain, low, high);
  if (problem) throw new Error(problem);
  const preset = resolvePreset(settings);
  const ext = settings as Settings & ExperimentalSettings;
  // Road clearance: half-size cells from the road to a little above the lowest body (non-wheel) point.
  const bodyParts = parts.filter((p) => p.role !== "wheel");
  const bodyLow = bodyParts.length ? boundsOf(bodyParts).low[2] : low[2];
  const clearanceBand = ext.clearanceBand ?? (CLEARANCE_BAND ? Math.min(1.5 * bodyLow + 0.02 * length, 0.25 * length) : 0);
  const grid = buildGrid({ domain, low, high, cellsPerLength: preset.cellsPerLength, levels: MG_LEVELS, wakeLength: ext.wakeLength, wakeGrowth: ext.wakeGrowth, phase: ext.phase, clearanceBand });
  timings.grid = performance.now() - t0;
  const { x, y, z } = grid;
  const nx = x.n, ny = y.n, nz = z.n;
  const cells = grid.cells;
  const hmin = grid.h;

  // Thin parts (thinner than ~2 cells) are rasterised as solid cell layers; everything else is cut.
  const vox = voxelize(grid, parts);
  const thin = new Set(vox.thinParts);
  const cutParts = parts.filter((_, i) => !thin.has(i));
  const ng = nodeGrid(grid);
  const inside = cutParts.length ? voxelize(ng, cutParts, false).solid : new Uint8Array(ng.cells);
  const band = 2.5 * hmin;
  const nd = nodeDistance(ng, parts, band);
  const partMap = parts.map((_, i) => i);
  const cutIndex = partMap.filter((i) => !thin.has(i));
  const sdf = new Float32Array(ng.cells);
  for (let n = 0; n < ng.cells; n++) sdf[n] = inside[n] ? -nd.dist[n] : nd.dist[n];
  // Thin parts: either zero-thickness walls of closed faces ("wall"), or smooth cut-cell plates
  // thickened to a minimum that the grid can carry ("dilate").
  const thinMode = ext.thinMode ?? THIN_MODE;
  if (thinMode === "dilate" && thin.size) {
    for (const p of thin) {
      const { volume, area } = meshVolumeArea(parts[p].positions);
      const half = 0.5 * Math.max(area > 0 ? (2 * Math.abs(volume)) / area : 0, THIN_MIN_CELLS * hmin);
      const dt = nodeDistance(ng, [parts[p]], band);
      for (let n = 0; n < ng.cells; n++) {
        const v = dt.dist[n] - half;
        if (v < sdf[n]) {
          sdf[n] = v;
          nd.part[n] = p;
        }
      }
    }
  }
  // Distances were computed against all parts; a node inside a cut part is negative regardless.
  const fr = fractions(grid, sdf, nd.part);
  void cutIndex;
  timings.voxelize = performance.now() - t0 - timings.grid;

  const theta = fr.theta, ax = fr.ax, ay = fr.ay, az = fr.az;
  const thetaMin = ext.thetaMin ?? THETA_MIN;
  // Thin parts become zero-thickness walls of closed faces instead of solid cell layers.
  if (thinMode === "wall") for (const p of thin) closeThinFaces(grid, parts[p].positions, p, ax, ay, az, fr.part);
  if (ext.debugStaircase) {
    // Diagnostic: staircase geometry through the same code path.
    for (let c = 0; c < cells; c++) {
      theta[c] = vox.solid[c] ? 0 : 1;
      ax[c] = ay[c] = az[c] = 1;
    }
  }
  const solidLabel = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) {
    if (theta[c] < thetaMin) theta[c] = 0;
  }
  // Boundary faces of the domain are open; faces touching a solid cell are closed; tiny slivers close.
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (i === nx - 1) ax[c] = 1;
        if (j === ny - 1) ay[c] = 1;
        if (k === nz - 1) az[c] = 1;
        if (!theta[c] || (i < nx - 1 && !theta[c + 1]) || ax[c] < 0.05) ax[c] = i === nx - 1 && theta[c] ? 1 : 0;
        if (!theta[c] || (j < ny - 1 && !theta[c + nx]) || ay[c] < 0.05) ay[c] = j === ny - 1 && theta[c] ? 1 : 0;
        if (!theta[c] || (k < nz - 1 && !theta[c + nx * ny]) || az[c] < 0.05) az[c] = k === nz - 1 && theta[c] ? 1 : 0;
      }

  // Keep only fluid connected to the inlet through open faces; sealed pockets become solid.
  const reach = new Uint8Array(cells);
  const stack = new Int32Array(cells);
  let top = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const c = nx * (j + ny * k);
      if (theta[c] && !reach[c]) {
        reach[c] = 1;
        stack[top++] = c;
      }
    }
  while (top > 0) {
    const c = stack[--top];
    const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
    const visit = (n: number, open: number) => {
      if (open > 0 && theta[n] && !reach[n]) {
        reach[n] = 1;
        stack[top++] = n;
      }
    };
    if (i > 0) visit(c - 1, ax[c - 1]);
    if (i < nx - 1) visit(c + 1, ax[c]);
    if (j > 0) visit(c - nx, ay[c - nx]);
    if (j < ny - 1) visit(c + nx, ay[c]);
    if (k > 0) visit(c - nx * ny, az[c - nx * ny]);
    if (k < nz - 1) visit(c + nx * ny, az[c]);
  }
  let sealedCells = 0;
  for (let c = 0; c < cells; c++)
    if (theta[c] && !reach[c]) {
      theta[c] = 0;
      sealedCells++;
    }
  for (let c = 0; c < cells; c++) {
    if (!theta[c]) {
      ax[c] = ay[c] = az[c] = 0;
      if (c % nx > 0) ax[c - 1] = 0;
      if (((c / nx) | 0) % ny > 0) ay[c - nx] = 0;
      if (c >= nx * ny) az[c - nx * ny] = 0;
    }
  }
  // Small-cell merging: link each sliver (θ < THETA_MERGE) to the neighbour across its most open
  // face. Direction code in flags bits 16–18: 1 −x, 2 +x, 3 −y, 4 +y, 5 −z, 6 +z.
  const link = new Uint8Array(cells);
  const orphan: number[] = [];
  let merged = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!theta[c] || theta[c] >= THETA_MERGE) continue;
        const Ax = y.widths[j] * z.widths[k], Ay = x.widths[i] * z.widths[k], Az = x.widths[i] * y.widths[j];
        const cand: [number, number, number, number][] = [
          [1, i > 0 ? ax[c - 1] : 0, Ax, i > 0 ? theta[c - 1] : 0],
          [2, i < nx - 1 ? ax[c] : 0, Ax, i < nx - 1 ? theta[c + 1] : 0],
          [3, j > 0 ? ay[c - nx] : 0, Ay, j > 0 ? theta[c - nx] : 0],
          [4, j < ny - 1 ? ay[c] : 0, Ay, j < ny - 1 ? theta[c + nx] : 0],
          [5, k > 0 ? az[c - nx * ny] : 0, Az, k > 0 ? theta[c - nx * ny] : 0],
          [6, k < nz - 1 ? az[c] : 0, Az, k < nz - 1 ? theta[c + nx * ny] : 0],
        ];
        // Masters must be substantial cells reached through a reasonably open face (no chains of
        // slivers, no links through a pinhole that would turn the sliver's mass imbalance into a jet).
        let best = 0, score = 0;
        for (const [d, alpha, area, th] of cand) {
          const sc = th >= THETA_MERGE && alpha >= 0.3 ? alpha * area * th : 0;
          if (sc > score) { score = sc; best = d; }
        }
        if (!best) {
          orphan.push(c);
          continue;
        }
        link[c] = best;
        merged++;
      }
  // Slivers without a substantial neighbour become solid (their faces were already tiny).
  for (const c of orphan) {
    theta[c] = 0;
    ax[c] = ay[c] = az[c] = 0;
    if (c % nx > 0) ax[c - 1] = 0;
    if (((c / nx) | 0) % ny > 0) ay[c - nx] = 0;
    if (c >= nx * ny) az[c - nx * ny] = 0;
  }
  for (let c = 0; c < cells; c++) {
    if (theta[c]) continue;
    const v = vox.solid[c];
    solidLabel[c] = v ? v : fr.part[c] !== 255 ? fr.part[c] + 1 : 1;
  }
  // Wall distance for SST blending: cells mostly inside the car count as wall.
  const wallMask = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) wallMask[c] = theta[c] < 0.5 ? 1 : 0;
  const dist = wallDistance(grid, wallMask);
  timings.walls = performance.now() - t0 - timings.grid - timings.voxelize;

  // Ghosted arrays.
  const NX = nx + 2, NY = ny + 2, NZ = nz + 2, NC = NX * NY * NZ;
  const gx = ghostAxis(x), gy = ghostAxis(y), gz = ghostAxis(z);
  const gridBuffer = new Float32Array(2 * (NX + NY + NZ));
  gridBuffer.set(gx.centers, 0);
  gridBuffer.set(gy.centers, NX);
  gridBuffer.set(gz.centers, NX + NY);
  const wb = NX + NY + NZ;
  gridBuffer.set(gx.widths, wb);
  gridBuffer.set(gy.widths, wb + NX);
  gridBuffer.set(gz.widths, wb + NX + NY);
  const flags = new Uint32Array(NC);
  const wallDist = new Float32Array(NC).fill(1e3);
  const aper = new Float32Array(NC * 4).fill(1);
  const wall = new Float32Array(NC * 4);
  const partIsWheel = parts.map((p) => p.role === "wheel");
  const wallList: number[] = [];
  let solidCells = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        const g = i + 1 + NX * (j + 1 + NY * (k + 1));
        wallDist[g] = dist[c];
        aper.set([ax[c], ay[c], az[c], theta[c]], 4 * g);
        if (!theta[c]) {
          flags[g] = 1 | ((solidLabel[c] - 1) << 8);
          solidCells++;
          continue;
        }
        // Wall area vector (pointing into the solid) from the aperture deficit of the six faces.
        const Ax = y.widths[j] * z.widths[k], Ay = x.widths[i] * z.widths[k], Az = x.widths[i] * y.widths[j];
        const aW = i > 0 ? ax[c - 1] : 1, aS = j > 0 ? ay[c - nx] : 1, aB = k > 0 ? az[c - nx * ny] : 1;
        const wx = -(ax[c] - aW) * Ax, wy = -(ay[c] - aS) * Ay, wz = -(az[c] - aB) * Az;
        const area = Math.hypot(wx, wy, wz);
        const face = Math.min(Ax, Ay, Az);
        const part = fr.part[c] !== 255 ? fr.part[c] : 0;
        flags[g] = (part << 8) | (link[c] << 16);
        if (area > 1e-3 * face) {
          const vol = x.widths[i] * y.widths[j] * z.widths[k];
          const hloc = Math.min(x.widths[i], y.widths[j], z.widths[k]);
          const yw = Math.min(Math.max((0.5 * theta[c] * vol) / area, 0.1 * hloc), 1.0 * hloc);
          wall.set([wx, wy, wz, yw], 4 * g);
          wallList.push(g, part | ((partIsWheel[part] ? 1 : 0) << 16));
        }
      }

  // Parts resting on the road (wheels whose small gap is below the grid spacing) have no fluid
  // under their lowest cells. Close their surface there with pressure-only contact faces that take
  // the pressure of the neighbouring road-level fluid, so forces do not depend on the pressure datum.
  let contactArea = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = i + nx * j;
      if (theta[c] > 0 && az[c] > 0) continue;
      const g = i + 1 + NX * (j + 1 + NY);
      const part = !theta[c] ? solidLabel[c] - 1 : fr.part[c] !== 255 ? fr.part[c] : 0;
      // open part of the cell's roof toward the solid above, or the whole solid cell footprint
      const area = x.widths[i] * y.widths[j] * (theta[c] ? 1 - az[c] : 1) * (theta[c] ? 0 : 1);
      if (area <= 0) continue;
      wall[4 * g + 2] = area;
      contactArea += area;
      wallList.push(g, part | ((partIsWheel[part] ? 1 : 0) << 16) | (1 << 17));
    }

  // Velocity: yaw adds lateral wind; the road and wheels follow the longitudinal road speed.
  const speed = settings.speed_kmh / 3.6;
  const yaw = (settings.yaw_deg * Math.PI) / 180;
  const inlet: Vec3 = [speed, speed * Math.tan(yaw), 0];
  const freestream = Math.hypot(inlet[0], inlet[1]);
  const sideMode = settings.yaw_deg > 0.05 ? 1 : settings.yaw_deg < -0.05 ? 2 : 0;
  const kIn = 1.5 * (0.01 * freestream) ** 2;
  const omegaIn = Math.sqrt(kIn) / (0.09 ** 0.25 * 0.07 * length);

  const boost = ext.mergeBoost ?? MERGE_BOOST;
  const boosted = (c: number, dir: number, nb: number) => (link[c] === dir || link[nb] === (dir % 2 === 0 ? dir - 1 : dir + 1) ? boost : 1);

  // Multigrid hierarchy. Face conductance α·A·β/d, where β = θ_face/θ_eff matches the momentum
  // update's clamped fluid fraction (see momentum kernel).
  const fluid0 = new Uint8Array(cells);
  const openX = new Float32Array(cells), openY = new Float32Array(cells), openZ = new Float32Array(cells);
  const beta = (t0c: number, w0: number, t1c: number, w1: number) => {
    const tf = (t0c * w0 + t1c * w1) / (w0 + w1);
    return SCALE_PRESSURE ? tf / Math.max(tf, THETA_EFF) : 1;
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!theta[c]) continue;
        fluid0[c] = 1;
        if (i < nx - 1) openX[c] = ax[c] * beta(theta[c], x.widths[i], theta[c + 1], x.widths[i + 1]) * boosted(c, 2, c + 1);
        if (j < ny - 1) openY[c] = ay[c] * beta(theta[c], y.widths[j], theta[c + nx], y.widths[j + 1]) * boosted(c, 4, c + nx);
        if (k < nz - 1) openZ[c] = az[c] * beta(theta[c], z.widths[k], theta[c + nx * ny], z.widths[k + 1]) * boosted(c, 6, c + nx * ny);
      }
  const levels: Level[] = [levelCoef(x, y, z, openX, openY, openZ, fluid0, sideMode)];
  const base = { x, y, z, openX, openY, openZ, fluid: fluid0, sideMode };
  // Galerkin coarsening for piecewise-constant prolongation (PᵀAP): a coarse face conductance is
  // the sum of the fine conductances crossing it; boundary terms add up.
  for (let l = 1; l < MG_LEVELS; l++) levels.push(galerkin(levels[l - 1]));
  timings.multigrid = performance.now() - t0 - timings.grid - timings.voxelize - timings.walls;
  const faces = new Uint32Array(wallList.length ? wallList : [0, 0]);

  // Frontal area of the solid model: projected columns containing a mostly-solid cell.
  let voxelFrontalArea = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++)
        if (theta[i + nx * (j + ny * k)] < 0.5) {
          voxelFrontalArea += y.widths[j] * z.widths[k];
          break;
        }
    }

  const partData = new Float32Array(MAX_PARTS * 4);
  parts.forEach((p, i) => {
    if (p.role === "wheel" && p.wheel && settings.wheels) {
      partData.set([p.wheel.center[0], p.wheel.center[1], p.wheel.center[2], -speed / p.wheel.radius], 4 * i);
    }
  });

  timings.total = performance.now() - t0;
  return {
    grid,
    NX,
    NY,
    NZ,
    NC,
    gridBuffer,
    goff: [0, NX, NX + NY, NX + NY + NZ],
    flags,
    wallDist,
    levels,
    faces,
    faceCount: wallList.length / 2,
    aper,
    wall,
    parts: partData,
    partIsWheel,
    inlet,
    groundSpeed: settings.moving_ground ? speed : 0,
    kIn,
    omegaIn,
    sideMode,
    speed,
    freestream,
    length,
    low,
    high,
    domain,
    solidCells,
    fluidCells: cells - solidCells,
    mergedCells: merged,
    contactArea,
    base,
    mergeBoost: boost,
    limiter: ext.limiter ?? 0,
    wallModel: ext.wallModel ?? WALL_MODEL,
    thinParts: vox.thinParts.map((i) => parts[i].name),
    sealedCells,
    voxelFrontalArea,
    timings,
  };
}

export { NU };
