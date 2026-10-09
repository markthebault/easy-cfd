import type { VizSettings } from "./stage";
import type { ViewName } from "./helpers";
import type { VizField } from "../solver/extract";

export type AnalysisMode = "overview" | "animation" | "pressure" | "friction" | "clouds" | "surfaceFlow" | "vertical" | "horizontal" | "wake" | "turbulence" | "forces";
export type AnalysisLayer = "animation" | "surface" | "smoke" | "streamlines" | "slice" | "wake" | "pressureCloud" | "forces";

export const ANALYSES: { id: AnalysisMode; title: string; description: string; layer: AnalysisLayer; view: ViewName; needsAnimation?: boolean; needsSurface?: boolean; needsStress?: boolean; needsForces?: boolean }[] = [
  { id: "overview", title: "Aero overview", description: "Surface pressure with air-speed streamlines around the car and in its wake.", layer: "streamlines", view: "side", needsSurface: true },
  { id: "pressure", title: "Surface pressure", description: "Find suction and high-pressure areas on the car.", layer: "surface", view: "iso", needsSurface: true },
  { id: "friction", title: "Surface friction", description: "Physical wall stress from the solver, in Pa or Cf.", layer: "surface", view: "iso", needsStress: true },
  { id: "clouds", title: "3D pressure clouds", description: "See pressure regions in the air around the car.", layer: "pressureCloud", view: "iso" },
  { id: "animation", title: "Flow animation", description: "Watch coloured smoke flow around the car and through its wake.", layer: "animation", view: "side", needsAnimation: true },
  { id: "vertical", title: "Vertical streamlines", description: "Follow air over the roof and under the floor.", layer: "streamlines", view: "side" },
  { id: "horizontal", title: "Horizontal streamlines", description: "See how air splits around the sides of the car.", layer: "streamlines", view: "top" },
  { id: "surfaceFlow", title: "Surface flow", description: "Read near-wall flow direction with oil-flow streaks.", layer: "surface", view: "iso", needsSurface: true },
  { id: "wake", title: "Wake losses", description: "Find the air that has lost total pressure.", layer: "wake", view: "iso" },
  { id: "turbulence", title: "Turbulence section", description: "Inspect modelled turbulent energy behind the car.", layer: "slice", view: "side" },
  { id: "forces", title: "Forces", description: "See drag, lift or downforce, and side force.", layer: "forces", view: "iso", needsForces: true },
];

/** Presets use car dimensions, rather than the much larger wind-tunnel box. */
export function analysisPreset(mode: AnalysisMode, v: VizSettings, f: VizField, bounds: { low: number[]; high: number[] }): Partial<VizSettings> {
  const { low, high } = bounds;
  const L = high[0] - low[0], W = high[1] - low[1], H = high[2] - low[2];
  const clamp = (value: number, axis: number) => Math.min(f.origin[axis] + f.spacing[axis] * (f.dims[axis] - 1), Math.max(f.origin[axis], value));
  const reset: Partial<VizSettings> = { friction: false, surface: false, surfaceFlow: false, smoke: false, streamlines: false, slice: false, wake: false, pressureCloud: false, forces: false, animation: false };
  if (mode === "friction") return { ...reset, friction: true };
  if (mode === "pressure") return { ...reset, surface: true };
  if (mode === "clouds") return { ...reset, pressureCloud: true };
  if (mode === "surfaceFlow") return { ...reset, surfaceFlow: true };
  if (mode === "forces") return { ...reset, forces: true };
  if (mode === "wake") return { ...reset, wake: true };
  if (mode === "animation") return { ...reset, animation: true, slice: true, sliceAxis: 1, slicePos: clamp((low[1] + high[1]) / 2, 1), sliceField: "speed", sliceTracers: false, motion: false, windDirection: false };
  if (mode === "turbulence") return { ...reset, slice: true, sliceAxis: 1, slicePos: clamp((low[1] + high[1]) / 2, 1), sliceField: "k", sliceTracers: false };
  if (mode === "overview") {
    const bottom = clamp(Math.max(low[2], f.origin[2]) + H * 0.03, 2);
    const top = clamp(high[2] + H * 0.18, 2);
    return { ...reset, surface: true, streamlines: true, motion: false, windDirection: false,
      stream: { ...v.stream, x: clamp(low[0] - L * 0.18, 0), y: clamp((low[1] + high[1]) / 2, 1), z: (bottom + top) / 2, length: top - bottom, count: 40, orientation: "vertical", animate: false, layout: "overview", wakeSeeds: true, thickness: 0.65, color: "flow" } };
  }
  const horizontal = mode === "horizontal";
  const centerZ = clamp(low[2] + H * 0.5, 2);
  const extent = horizontal ? W * 1.25 : H * 1.15;
  const axis = horizontal ? 1 : 2;
  const center = horizontal ? clamp((low[1] + high[1]) / 2, 1) : centerZ;
  const room = 2 * Math.max(0, Math.min(center - f.origin[axis], f.origin[axis] + f.spacing[axis] * (f.dims[axis] - 1) - center));
  return { ...reset, streamlines: true, stream: { ...v.stream, x: clamp(low[0] - L * 0.14, 0), y: clamp((low[1] + high[1]) / 2, 1), z: centerZ, length: Math.min(extent, room), orientation: horizontal ? "horizontal" : "vertical", layout: "single", wakeSeeds: false, thickness: 3.2, color: "speed" } };
}

export function activeAnalysis(v: VizSettings): AnalysisMode | null {
  const count = [v.smoke, v.streamlines, v.slice, v.wake, v.pressureCloud, v.forces, v.surface || v.friction || v.surfaceFlow].filter(Boolean).length;
  if (count === 2 && v.surface && !v.friction && !v.surfaceFlow && v.streamlines && v.stream.layout === "overview") return "overview";
  if (count !== 1) return null;
  if (v.pressureCloud) return "clouds";
  if (v.forces) return "forces";
  if (v.streamlines) return v.stream.orientation === "vertical" ? "vertical" : "horizontal";
  if (v.slice && v.animation) return "animation";
  if (v.slice && v.sliceField === "k") return "turbulence";
  if (v.wake) return "wake";
  if (v.friction) return "friction";
  if (v.surfaceFlow) return "surfaceFlow";
  if (v.surface) return "pressure";
  return null;
}
