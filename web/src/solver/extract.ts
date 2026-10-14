// Computed OpenFOAM fields shared by the browser, server and WebGL viewer.

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

/** The visualisation window around a car (bounds low/high, length L) inside a tunnel domain. */
export function vizBoxFor(low: Vec3, high: Vec3, domain: number[], L: number): { low: Vec3; high: Vec3 } {
  const [x0, x1, y0, y1, , z1] = domain;
  const W = high[1] - low[1];
  return {
    low: [Math.max(x0, low[0] - 0.6 * L), Math.max(y0, low[1] - 0.25 * W - 0.25 * L), 0],
    high: [Math.min(x1, high[0] + 2.2 * L), Math.min(y1, high[1] + 0.25 * W + 0.25 * L), Math.min(z1, high[2] + 0.45 * L)],
  };
}

/** Uniform grid of about `target` points over a box (the layout every VizField uses). */
export function vizGrid(low: Vec3, high: Vec3, target: number): { origin: Vec3; spacing: Vec3; dims: [number, number, number] } {
  const ext: Vec3 = [high[0] - low[0], high[1] - low[1], high[2] - low[2]];
  const h = Math.cbrt((ext[0] * ext[1] * ext[2]) / target);
  const dims: [number, number, number] = [Math.max(8, Math.round(ext[0] / h)), Math.max(8, Math.round(ext[1] / h)), Math.max(8, Math.round(ext[2] / h))];
  const spacing: Vec3 = [ext[0] / (dims[0] - 1), ext[1] / (dims[1] - 1), ext[2] / (dims[2] - 1)];
  return { origin: low, spacing, dims };
}
