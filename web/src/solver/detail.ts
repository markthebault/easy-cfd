// Detail refinement: finer cells around parts that are thin or small for the grid (wings,
// endplates, canards, splitters) and inside user-defined detail boxes. The grid is a tensor
// product, so each zone becomes a band of finer spacing along the axes in which it is small.

import { buildGrid, type Band, type Grid, type GridRequest } from "./grid";
import { meshVolumeArea } from "./voxelize";
import type { DetailBox, SolverPart, Vec3 } from "./types";

/** Largest grid the detail refinement may produce; the refinement ratio is lowered to fit. */
export const DETAIL_CELL_BUDGET = 4_500_000;
/** An axis of a zone is refined when the zone spans fewer base cells than this along it. */
const SMALL_AXIS_CELLS = 12;
/** Parts smaller than this many base cells in every direction count as small details. */
const SMALL_PART_CELLS = 6;

export interface DetailZone {
  name: string;
  lo: Vec3;
  hi: Vec3;
  /** Axes (x, y, z) along which the zone gets finer cells. */
  axes: [boolean, boolean, boolean];
}

function bounds(tri: Float32Array): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], tri[i + a]);
      hi[a] = Math.max(hi[a], tri[i + a]);
    }
  return { lo, hi };
}

/** What detail selection needs from a part (computed once; independent of the grid). */
export interface PartShape {
  name: string;
  role: "body" | "wheel";
  detail: "auto" | "always" | "off";
  lo: Vec3;
  hi: Vec3;
  /** 2 × volume / area: plate thickness for thin parts. */
  thickness: number;
}

export function partShapes(parts: SolverPart[]): PartShape[] {
  return parts.map((p) => {
    const { lo, hi } = bounds(p.positions);
    const detail = p.detail ?? "auto";
    // The volume is only needed for parts that may qualify automatically.
    let thickness = Infinity;
    if (detail === "auto" && p.role !== "wheel") {
      const { volume, area } = meshVolumeArea(p.positions);
      thickness = area > 0 ? (2 * Math.abs(volume)) / area : 0;
    }
    return { name: p.name, role: p.role, detail, lo, hi, thickness };
  });
}

/**
 * Zones to refine for a base spacing h. Parts in "auto" mode qualify when they are thinner than
 * 1.5 base cells or smaller than a few cells overall; wheels only when asked ("always").
 */
export function detailZones(shapes: PartShape[], h: number, boxes: DetailBox[] = []): DetailZone[] {
  const zones: DetailZone[] = [];
  for (const p of shapes) {
    if (p.detail === "off" || (p.detail === "auto" && p.role === "wheel")) continue;
    const ext = [0, 1, 2].map((a) => p.hi[a] - p.lo[a]);
    if (p.detail === "auto" && !(p.thickness < 1.5 * h || Math.max(...ext) < SMALL_PART_CELLS * h)) continue;
    let axes = ext.map((e) => e < SMALL_AXIS_CELLS * h) as [boolean, boolean, boolean];
    if (!axes.some(Boolean)) axes = [true, true, true];
    zones.push({ name: p.name, lo: p.lo, hi: p.hi, axes });
  }
  for (const b of boxes)
    zones.push({ name: b.name || "Detail box", lo: [b.x_min, b.y_min, b.z_min], hi: [b.x_max, b.y_max, b.z_max], axes: [true, true, true] });
  return zones;
}

/**
 * Grid with detail bands at the requested ratio, lowered in steps of 0.5 until the grid fits the
 * cell budget (or the budget is below the plain grid, which then runs without detail).
 */
export function detailGrid(req: GridRequest, zones: DetailZone[], requested: number, budget = DETAIL_CELL_BUDGET): { grid: Grid; ratio: number; requested: number } {
  const h = (req.high[0] - req.low[0]) / req.cellsPerLength;
  const want = zones.length ? Math.min(Math.max(requested, 1), 4) : 1;
  const plain = buildGrid(req);
  let ratio = want;
  let grid = ratio > 1 ? buildGrid({ ...req, bands: detailBands(zones, h, ratio) }) : plain;
  while (ratio > 1 && grid.cells > Math.max(budget, 1.02 * plain.cells)) {
    ratio = Math.max(1, ratio - 0.5);
    grid = ratio > 1 ? buildGrid({ ...req, bands: detailBands(zones, h, ratio) }) : plain;
  }
  return { grid, ratio, requested: want };
}

/** Bands of spacing h / ratio around each zone, with a margin of a few fine cells. */
export function detailBands(zones: DetailZone[], h: number, ratio: number): [Band[], Band[], Band[]] {
  const out: [Band[], Band[], Band[]] = [[], [], []];
  if (ratio <= 1) return out;
  const s = h / ratio;
  for (const z of zones)
    for (let a = 0; a < 3; a++) {
      if (!z.axes[a]) continue;
      const m = Math.max(3 * s, 0.1 * (z.hi[a] - z.lo[a]));
      out[a].push({ lo: z.lo[a] - m, hi: z.hi[a] + m, h: s });
    }
  return out;
}
