import type { Settings } from "../solver/types";
import { backendAvailable, NATIVE_OPENFOAM_ENABLED } from "./connection";

/** Build-time opt-in for automatic discovery of a native, same-origin backend. */
export const OPENFOAM_ENABLED = NATIVE_OPENFOAM_ENABLED;
export const OPENFOAM_COMING_SOON = "Connect a remote OpenFOAM server below to enable this engine.";

/** Reopened OpenFOAM designs fall back to WebGPU when no backend is configured. */
export function availableSettings(settings: Settings): Settings {
  // A configured remote server is independent of the native build flag.
  if (backendAvailable() || settings.engine !== "openfoam") return settings;
  return { ...settings, engine: "webgpu", profile: "regular", quality: "medium", max_seconds: 600, flow_detail: "standard" };
}
