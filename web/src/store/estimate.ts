// Cell count (exact: the same grid builder the solver uses) and a rough run-time estimate that
// calibrates itself from the runs completed on this machine.

import { buildGrid } from "../solver/grid";
import { domainFor, MG_LEVELS } from "../solver/setup";
import { resolvePreset, type Settings, type Vec3 } from "../solver/types";

const KEY = "easycfd.calibration";

interface Calibration {
  /** Cell-steps per second of solver work. */
  throughput: number;
  /** Steps per (pass × cell along the car). */
  stepsPerPassCell: number;
  runs: number;
}

// Conservative defaults until a run on this machine replaces them.
const DEFAULT: Calibration = { throughput: 1.5e8, stepsPerPassCell: 4, runs: 0 };

export function calibration(): Calibration {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (c && c.throughput > 0 && c.stepsPerPassCell > 0) return c;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

export function recordRun(cells: number, steps: number, solveSeconds: number, passes: number, cellsPerLength: number) {
  if (!(solveSeconds > 1) || !(steps > 10)) return;
  const c = calibration();
  const w = c.runs === 0 ? 1 : 0.4;
  const next: Calibration = {
    throughput: c.throughput * (1 - w) + ((cells * steps) / solveSeconds) * w,
    stepsPerPassCell: c.stepsPerPassCell * (1 - w) + (steps / (passes * cellsPerLength)) * w,
    runs: c.runs + 1,
  };
  localStorage.setItem(KEY, JSON.stringify(next));
}

export interface Estimate {
  cells: number;
  grid: [number, number, number];
  seconds: number;
  calibrated: boolean;
}

export function estimate(low: Vec3, high: Vec3, settings: Settings): Estimate | null {
  if (!(high[0] > low[0])) return null;
  if (settings.quality === "precise") {
    // Precise solves the Medium grid first, then the fine one.
    const a = estimate(low, high, { ...settings, quality: "medium" });
    const b = estimateLevel(low, high, settings);
    return a && b ? { ...b, seconds: a.seconds + b.seconds } : b;
  }
  return estimateLevel(low, high, settings);
}

function estimateLevel(low: Vec3, high: Vec3, settings: Settings): Estimate | null {
  try {
    const preset = resolvePreset(settings);
    const grid = buildGrid({ domain: domainFor(settings, low, high), low, high, cellsPerLength: preset.cellsPerLength, levels: MG_LEVELS });
    const c = calibration();
    const steps = c.stepsPerPassCell * preset.passes * preset.cellsPerLength;
    return { cells: grid.cells, grid: [grid.x.n, grid.y.n, grid.z.n], seconds: (grid.cells * steps) / c.throughput + 3, calibrated: c.runs > 0 };
  } catch {
    return null;
  }
}
