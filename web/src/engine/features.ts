import type { Settings } from "../solver/types";
import { backendAvailable, NATIVE_OPENFOAM_ENABLED } from "./connection";
import { isWasmQuality, WASM_PRESETS } from "./wasmPresets";

/** Build-time opt-in for automatic discovery of a native, same-origin backend. */
export const OPENFOAM_ENABLED = NATIVE_OPENFOAM_ENABLED;
export const OPENFOAM_COMING_SOON = "Connect a remote OpenFOAM server below to enable this engine.";

/** Keep old saved results; migrate runnable WebGPU designs to browser OpenFOAM. */
export function availableSettings(settings: Settings): Settings {
  if (settings.engine === "openfoam" && backendAvailable()) return settings;
  const fallback=settings.engine === "openfoam";
  const quality=!fallback && isWasmQuality(settings.quality) && (settings.engine === "wasm" || settings.quality !== "precise") ? settings.quality : "fast";
  const preset=WASM_PRESETS[quality];
  return { ...settings, engine: "wasm", profile: quality === "fast" ? "basic" : "regular", quality,
    max_seconds: Math.min(settings.max_seconds ?? preset.seconds,preset.seconds),
    flow_animation: false, flow_detail: "standard" };
}

export function engineLabel(result: {engine?:string;openfoam?:{runtime?:string}}):string {
  return result.openfoam?.runtime === "wasm" ? "OpenFOAM · Browser" : result.engine === "openfoam" ? "OpenFOAM" : "WebGPU";
}
