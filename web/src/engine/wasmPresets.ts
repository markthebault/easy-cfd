import type { Quality } from "../solver/types";

export const WASM_PRESETS = {
  fast: { label: "Quick", blurb: "Check the car and airflow", cellsPerLength: 5, surface: 2, wake: 1, layers: 0, iterations: 180, maxCells: 100_000, seconds: 300 },
  medium: { label: "Fast", blurb: "Finer car mesh", cellsPerLength: 7, surface: 3, wake: 1, layers: 1, iterations: 300, maxCells: 220_000, seconds: 600 },
  precise: { label: "Detailed", blurb: "Finer mesh and longer solve", cellsPerLength: 9, surface: 4, wake: 2, layers: 1, iterations: 1_000, maxCells: 600_000, seconds: 3_600 },
} as const;

export type WasmQuality = keyof typeof WASM_PRESETS;

export function isWasmQuality(quality: Quality): quality is WasmQuality {
  return Object.hasOwn(WASM_PRESETS, quality);
}

export function wasmPreset(quality: Quality) {
  return WASM_PRESETS[isWasmQuality(quality) ? quality : "fast"];
}
