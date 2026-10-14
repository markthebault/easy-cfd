// Force histories use OpenFOAM solver iterations.

export interface HistoryUnit {
  one: string;
  many: string;
  axis: string;
  /** Averaging windows offered, in units. */
  choices: number[];
}

/** OpenFOAM reports the mean of the last 50 iterations; windows are in iterations. */
export const ITERATIONS: HistoryUnit = { one: "iteration", many: "iterations", axis: "iterations", choices: [50, 100, 200, 500] };
