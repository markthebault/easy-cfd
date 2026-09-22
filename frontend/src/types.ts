export type Settings = {
  speed_kmh: number;
  yaw_deg: number;
  quality: "fast" | "medium" | "precise";
  reference_area: number;
  density: number;
  moving_ground: boolean;
  wheels: boolean;
  geometry_confirmed: boolean;
};
export type Part = {
  id: string;
  name: string;
  role: "body" | "wheel";
  wheel: { radius: number; center: number[] } | null;
  triangles: number;
  bounds: number[][];
  issues: string[];
};
export type Geometry = {
  parts: Part[];
  bounds: number[][];
  dimensions: number[];
  errors: string[];
  warnings: string[];
  triangles: number;
  fingerprint: string;
  frontal_area_estimate: number;
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
  warnings: string[];
  breakdown?: Breakdown;
  blockage_ratio?: number;
  ranges: Record<string, number[]>;
  history: { iteration: number; cd: number; cl: number }[];
  timings: Record<string, number>;
  y_plus: { patch: string; minimum: number; maximum: number; mean: number }[];
  refinement?: { delta_cd: number; delta_cl: number; both_settled: boolean };
};
export type Run = {
  id: string;
  name: string;
  created: string;
  project_id: string;
  status: string;
  stage: string;
  settings: Settings;
  geometry: Geometry;
  iteration: number;
  result?: Result;
  error?: string;
};
export type Health = {
  ready: boolean;
  message: string;
  memory_gb?: number;
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
