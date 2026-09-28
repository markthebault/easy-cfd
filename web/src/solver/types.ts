// Shared solver types. Coordinates are metres: nose toward −X, air toward +X, +Z up, road at Z = 0.

export type Vec3 = [number, number, number];

export interface Wheel {
  center: Vec3;
  radius: number;
}

export interface SolverPart {
  id: string;
  name: string;
  role: "body" | "wheel";
  /** Flat triangle soup, 9 floats per triangle. */
  positions: Float32Array;
  wheel?: Wheel | null;
}

export type Quality = "fast" | "medium" | "precise" | "custom";

export interface SimulationBox {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  z_max: number;
}

export interface Settings {
  speed_kmh: number;
  yaw_deg: number;
  quality: Quality;
  reference_area: number;
  density: number;
  moving_ground: boolean;
  wheels: boolean;
  simulation_box: SimulationBox | null;
  /** Custom: cells along the car length. */
  custom_cells: number;
  /** Custom: simulated flow passes (car lengths travelled by the free stream). */
  custom_passes: number;
}

/**
 * Numerical switches used by the validation study (validation/run-validation.mjs --settings).
 * The app never sets them; defaults are the validated configuration.
 */
export interface ExperimentalSettings {
  wallModel?: "k" | "log";
  limiter?: number;
  thinMode?: "wall" | "dilate";
  thetaMin?: number;
  mergeBoost?: number;
  wakeLength?: number;
  wakeGrowth?: number;
  phase?: [number, number, number];
  clearanceBand?: number;
  debugStaircase?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  speed_kmh: 100,
  yaw_deg: 0,
  quality: "medium",
  reference_area: 2.2,
  density: 1.225,
  moving_ground: true,
  wheels: true,
  simulation_box: null,
  custom_cells: 72,
  custom_passes: 10,
};

export const NU = 1.5e-5;
export const G = 9.80665;

export interface Preset {
  label: string;
  /** Cells along the car length in the refined region. */
  cellsPerLength: number;
  /** Simulated time in car-length flow passes. */
  passes: number;
  /** Final fraction of the run used for averaging forces. */
  averageFraction: number;
}

export const PRESETS: Record<Exclude<Quality, "custom">, Preset> = {
  // Surface resolution chosen to bracket the OpenFOAM app's levels (Medium ≈ its 6 cm surface cells
  // on a 4.2 m car).
  fast: { label: "Fast", cellsPerLength: 72, passes: 5, averageFraction: 0.3 },
  medium: { label: "Medium", cellsPerLength: 72, passes: 10, averageFraction: 0.3 },
  // Precise solves the Medium grid and this finer one, and reports their mean (see runSimulation).
  precise: { label: "Precise", cellsPerLength: 100, passes: 10, averageFraction: 0.3 },
};

export function resolvePreset(s: Settings): Preset {
  if (s.quality === "custom")
    return { label: "Custom", cellsPerLength: s.custom_cells, passes: s.custom_passes, averageFraction: 0.3 };
  return PRESETS[s.quality];
}

export interface ForceSample {
  time: number;
  step: number;
  cd: number;
  cl: number;
  cs: number;
}

export interface ForceBreakdown {
  bodyPressure: Vec3;
  bodyViscous: Vec3;
  wheelPressure: Vec3;
  wheelViscous: Vec3;
}

export interface RunResult {
  cd: number;
  cl: number;
  cs: number;
  drag: number;
  lift: number;
  side: number;
  /** Positive when pushing the car onto the road. */
  downforce: number;
  breakdown: ForceBreakdown;
  history: ForceSample[];
  settled: boolean;
  cdSpan: number;
  clSpan: number;
  cells: number;
  steps: number;
  simulatedTime: number;
  wallSeconds: number;
  freestream: number;
  dynamicPressure: number;
  domain: [number, number, number, number, number, number];
  blockage: number;
  warnings: string[];
  /** Precise preset: the two grid levels behind the reported mean, and their difference. */
  levels?: { label: string; cells: number; cd: number; cl: number; drag: number; lift: number }[];
  meshSensitivity?: { dCd: number; dCl: number };
  /** ± spread of Cd and Cl over the averaging window (half the range of sub-window means). */
  cdBand?: number;
  clBand?: number;
  /** Flow passes added automatically because forces were still drifting. */
  extendedPasses?: number;
}
