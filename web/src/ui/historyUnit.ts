// The x axis of a force history: flow passes (WebGPU) or solver iterations (OpenFOAM).

export interface HistoryUnit {
  one: string;
  many: string;
  axis: string;
  /** Averaging windows offered, in units. */
  choices: number[];
}

export const PASSES: HistoryUnit = { one: "pass", many: "passes", axis: "flow passes", choices: [1, 2, 3, 5, 10] };
/** OpenFOAM reports the mean of the last 50 iterations; windows are in iterations. */
export const ITERATIONS: HistoryUnit = { one: "iteration", many: "iterations", axis: "iterations", choices: [50, 100, 200, 500] };

export const unitFor = (engine: string | undefined) => (engine === "openfoam" ? ITERATIONS : PASSES);
