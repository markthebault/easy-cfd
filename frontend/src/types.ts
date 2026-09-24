export type SimulationBox = {
  x_min: number; x_max: number; y_min: number; y_max: number; z_max: number;
};
export type Settings = {
  speed_kmh: number;
  yaw_deg: number;
  quality: "fast" | "medium" | "precise" | "custom";
  simulation_box?: SimulationBox | null;
  custom_mesh?: "fast" | "medium" | "precise";
  custom_iterations?: number;
  reference_area: number;
  density: number;
  moving_ground: boolean;
  wheels: boolean;
  geometry_confirmed: boolean;
};
export type Part = {
  grouped_components?: number;
  id: string;
  name: string;
  role: "body" | "wheel";
  wheel: { radius: number; center: number[] } | null;
  triangles: number;
  bounds: number[][];
  issues: string[];
  // Absent on geometry saved before parts could be switched off: treat as enabled.
  enabled?: boolean;
  source?: number;
};
export type ImportOptions = {
  components?: "split" | "group";
  units: "m" | "mm" | "cm" | "in";
  forward: string;
  up: string;
  clearance: number;
};
export type Source = { file: string; name: string; base: boolean };
export type Geometry = {
  repaired?: boolean;
  transformed?: boolean;
  parts: Part[];
  bounds: number[][];
  dimensions: number[];
  errors: string[];
  warnings: string[];
  triangles: number;
  fingerprint: string;
  frontal_area_estimate: number;
  // Only imported models keep originals, so only they can be re-oriented or extended.
  sources?: Source[];
  import_options?: ImportOptions;
};
export type Project = {
  id: string;
  name: string;
  created: string;
  settings: Settings;
  geometry: Geometry | null;
  sample?: string;
};
export type RoleBreakdown = {
  drag: number;
  downforce: number;
  cd: number;
  cl: number;
  pressure_drag: number;
  viscous_drag: number;
  pressure_downforce: number;
  viscous_downforce: number;
};
export type Breakdown = {
  body: RoleBreakdown;
  wheels?: RoleBreakdown;
  pressure_drag: number;
  viscous_drag: number;
  consistent: boolean;
};
export type Result = {
  drag: number;
  downforce: number;
  cd: number;
  cl: number;
  force_settled: boolean;
  residual_converged: boolean;
  residuals: Record<string, number>;
  cells: number;
  iteration: number;
  averaging_iterations?: number;
  warnings: string[];
  breakdown?: Breakdown;
  blockage_ratio?: number;
  ranges: Record<string, number[]>;
  // Omitted from the polled run list; fetch the single run for it.
  history?: { iteration: number; cd: number; cl: number }[];
  timings: Record<string, number>;
  y_plus: { patch: string; minimum: number; maximum: number; mean: number }[];
  refinement?: { delta_cd: number; delta_cl: number; both_settled: boolean };
};
export type Run = {
  domain?: number[];
  id: string;
  name: string;
  created: string;
  project_id: string;
  status: string;
  stage: string;
  settings: Settings;
  geometry: Geometry;
  configuration?: { added: string[]; excluded: string[] };
  iteration: number;
  result?: Result;
  error?: string;
  disk_bytes?: number;
};
export type Health = {
  ready: boolean;
  message: string;
  memory_gb?: number;
  cpus?: number;
  architecture?: string;
  presets: Record<string, { memory_gb: number; iterations: number }>;
};
export type Comparison = {
  changes: Record<
    string,
    { baseline: number; variant: number; delta: number; percent: number | null }
  >;
  warnings: string[];
  comparable: boolean;
  parts?: {
    same: boolean;
    only_baseline: string[];
    only_variant: string[];
  } | null;
  ranges: Record<string, number[]>;
};
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch("/api" + url, options);
  if (!response.ok) {
    const data = await response
      .json()
      .catch(() => ({ detail: response.statusText }));
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : JSON.stringify(data.detail),
    );
  }
  return response.json();
}
export function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
