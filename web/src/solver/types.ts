// Shared solver types. Coordinates are metres: nose toward −X, air toward +X, +Z up, road at Z = 0.

export type Vec3 = [number, number, number];

/** Coordinates in the car frame; the moment origin is on the road below the front axle. */
export interface Axles { frontX: number; rearX: number; centrelineY: number; confirmed: boolean; source?: "wheels" | "manual" }
export interface AeroBalance {
  frontLift: number; rearLift: number; frontCl: number; rearCl: number;
  wheelbase: number; pitch: number; frontDownforcePercent?: number; percentageReason?: string;
}
export interface AeroIntegral {
  force: Vec3; moment: Vec3; origin: Vec3;
  pressureMoment: Vec3; frictionMoment: Vec3;
}

export interface VehicleWeight {
  /** Running mass including driver and fuel. Postprocessing only; does not change CFD. */
  vehicle_mass_kg?: number;
  /** Static share of weight carried by the front axle, 0–100 %. */
  front_weight_percent?: number;
}

export interface TyreLoads {
  version: "steady-axle-loads-1";
  massKg: number;
  frontWeightPercent: number;
  gravity: number;
  front: { staticN: number; aerodynamicN: number; totalN: number };
  rear: { staticN: number; aerodynamicN: number; totalN: number };
  contactFeasible: boolean;
}

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
  /** Simulated (default). False: the part only shapes the grid, e.g. a variant that is switched off. */
  active?: boolean;
  /** Finer cells around the part: auto (thin or small parts), always, or off. */
  detail?: "auto" | "always" | "off";
  /** Group id in the app, reported with per-part forces. */
  group?: string;
}

/** A user-defined box refined like a detail part (holes, vents, gaps inside a larger part). */
export interface DetailBox {
  name?: string;
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  z_min: number;
  z_max: number;
}

export type Quality = "fast" | "medium" | "precise" | "custom";

export interface SimulationBox {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  z_max: number;
}

export interface Settings extends VehicleWeight {
  axles?: Axles;
  refine_groups?: string[];
  refine_underfloor?: boolean;
  profile?: "basic" | "regular" | "advanced1" | "advanced2";
  /** Device-specific preflight limit, populated at runtime, not a quality adjustment. */
  gpu_buffer_limit?: number;
  /** Shared whole-job elapsed-time ceiling, seconds. */
  max_seconds?: number;
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
  /**
   * Detail cells around thin or small parts and in detail boxes: this many times finer than the
   * base spacing (1: off, the default; up to 4). Opt-in: see VALIDATION.md (aero parts).
   */
  detail_ratio?: number;
  /** User-defined detail boxes (world coordinates, metres). */
  detail_boxes?: DetailBox[];
  /** Solver: WebGPU in this browser (default) or the OpenFOAM app's backend. */
  engine?: "webgpu" | "openfoam";
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
  /** Cell budget for detail refinement (default DETAIL_CELL_BUDGET). */
  detailBudget?: number;
  /** Thin-part threshold in cells (default 1.5); a large value forces the zero-thickness model. */
  thinCells?: number;
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

/** Detail refinement ratio of a run (1: off). */
export const detailRatio = (s: Settings) => Math.min(Math.max(s.detail_ratio ?? 1, 1), 4);

export function resolvePreset(s: Settings): Preset {
  if (s.quality === "custom")
    return { label: "Custom", cellsPerLength: s.custom_cells, passes: s.custom_passes, averageFraction: 0.3 };
  return PRESETS[s.quality];
}

export interface ForceSample {
  pitch?: number;
  frontLift?: number;
  rearLift?: number;
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

/** Time-averaged force on one part (N), over the same window as the totals. */
export interface PartForce {
  pressureMoment?: Vec3;
  frictionMoment?: Vec3;
  id: string;
  name: string;
  group?: string;
  /** Pressure force (x drag, y side, z lift). */
  pressure: Vec3;
  /** Wall friction. */
  friction: Vec3;
}

export interface RunResult {
  tyreLoads?: TyreLoads;
  wallIntegration?: { iteration: number; coverage: number; faces: number; forceError: number; momentError: number; frictionError: number; tolerance: number; forceTolerance?: number; momentTolerance?: number; passed: boolean };
  aero?: AeroIntegral;
  balance?: AeroBalance;
  balanceBands?: { frontLift: number; rearLift: number; pitch: number };
  provenance?: { version: string; averaging: { start: number; end: number; unit: "pseudo-time" | "iteration" }; origin: Vec3; qualification: "exploratory"; aggregation?: "mean-of-levels"; averagingLevels?: {start:number;end:number;unit:"pseudo-time"|"iteration"}[]; historyGrid?: string; geometry?: string; mesh?: string; pipeline?: string };
  reconciliation?: { forceError: number; momentError: number; forceTolerance: number; momentTolerance: number; complete: boolean };
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
  levels?: { label: string; cells: number; cd: number; cl: number; drag: number; lift: number; aero?: AeroIntegral; balance?: AeroBalance }[];
  meshSensitivity?: { dCd: number; dCl: number; frontLift?: number; rearLift?: number; pitch?: number };
  /** ± spread of Cd and Cl over the averaging window (half the range of sub-window means). */
  cdBand?: number;
  clBand?: number;
  /** Flow passes added automatically because forces were still drifting. */
  extendedPasses?: number;
  /** Car length the grid and flow passes are based on (all parts that shape the grid), m. */
  length?: number;
  /** Identifies the grid: equal for runs on identical cells. */
  gridId?: string;
  /** Forces per simulated part (same order as the parts sent to the solver). */
  partForces?: PartForce[];
  /** Detail refinement used: ratio (1 off), smallest cell, refined parts and boxes. */
  detail?: { ratio: number; requested: number; hmin: number; zones: string[] };
  /** Solver that produced the result (absent: WebGPU). */
  engine?: "webgpu" | "openfoam";
  /** OpenFOAM runs: server run, iterations, convergence and mesh details. */
  openfoam?: OpenFoamDetails;
}

export interface OpenFoamDetails {
  run: string;
  project?: string;
  iterations: number;
  /** Forces are the mean over the last this many iterations. */
  averagingIterations: number;
  residuals: Record<string, number>;
  residualConverged: boolean;
  meshOk?: boolean;
  layerCoverage?: number;
  /** Share of wall points in the y+ target range. */
  wallTargetFraction?: number;
  /** Translation from the UI's frame to the server run's frame (m). */
  offset: Vec3;
}
