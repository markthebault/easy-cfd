import type { Settings } from "../solver/types";

/** Build-time opt-in: public static builds never contact an OpenFOAM backend. */
export const OPENFOAM_ENABLED = import.meta.env.VITE_ENABLE_OPENFOAM === "true";
export const OPENFOAM_COMING_SOON = "Coming soon: OpenFOAM runs on demand.";

/** Reopened local-server designs remain runnable in the WebGPU-only edition. */
export function availableSettings(settings: Settings): Settings {
  if (OPENFOAM_ENABLED || settings.engine !== "openfoam") return settings;
  return { ...settings, engine: "webgpu", profile: "regular", quality: "medium", max_seconds: 600, flow_detail: "standard" };
}
