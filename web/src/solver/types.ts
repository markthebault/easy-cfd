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
  /** Group id in the app, reported with per-part forces. */
  group?: string;
}

export type Quality = "fast" | "medium" | "precise";

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
  /** Shared whole-job elapsed-time ceiling, seconds. */
  max_seconds?: number;
  /** Record a physical-time airflow sequence after the steady solve. */
  flow_animation?: boolean;
  /** Native OpenFOAM DDES with directly sampled, detailed sections. */
  flow_detail?: "standard" | "fine";
  speed_kmh: number;
  yaw_deg: number;
  quality: Quality;
  reference_area: number;
  density: number;
  moving_ground: boolean;
  wheels: boolean;
  simulation_box: SimulationBox | null;
  /** Browser OpenFOAM (default) or a connected native backend. */
  engine?: "wasm" | "openfoam";
}

export const DEFAULT_SETTINGS: Settings = {
  speed_kmh: 100,
  yaw_deg: 0,
  quality: "fast",
  engine: "wasm",
  reference_area: 2.2,
  density: 1.225,
  moving_ground: true,
  wheels: true,
  simulation_box: null,
};

export const G = 9.80665;

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
  provenance?: { version: string; averaging: { start: number; end: number; unit: "iteration" }; origin: Vec3; qualification: "exploratory"; geometry?: string; mesh?: string; pipeline?: string };
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
  /** Native mesh refinement levels, with the last completed level reported. */
  levels?: { label: string; cells: number; cd: number; cl: number; drag: number; lift: number; aero?: AeroIntegral; balance?: AeroBalance }[];
  meshSensitivity?: { dCd: number; dCl: number; frontLift?: number; rearLift?: number; pitch?: number };
  /** ± spread of Cd and Cl over the averaging window (half the range of sub-window means). */
  cdBand?: number;
  clBand?: number;
  /** Car length used by the sampling window, m. */
  length?: number;
  /** Identifies the grid: equal for runs on identical cells. */
  gridId?: string;
  /** Forces per simulated part (same order as the parts sent to the solver). */
  partForces?: PartForce[];
  engine: "openfoam";
  /** OpenFOAM run, iterations, convergence and mesh details. */
  openfoam?: OpenFoamDetails;
}

export interface OpenFoamDetails {
  /** Browser WASM runs share the server's result contract without a backend endpoint. */
  runtime?: "wasm";
  /** Backend endpoint, without its token; absent in older native runs. */
  backend?: string;
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
