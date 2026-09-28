// Statistics of force coefficients over a trailing window of flow passes, and the matching
// moving average for the force chart. Used to read noisy or oscillating Cd/Cl histories.

import type { ForceSample } from "../solver/types";

export interface Stats {
  mean: number;
  median: number;
  min: number;
  max: number;
  n: number;
}

function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  return { mean: values.reduce((a, b) => a + b, 0) / n, median, min: s[0], max: s[n - 1], n };
}

/** Cd and Cl statistics over samples with time ≥ `from` (seconds of simulated time). */
export function statsFrom(history: ForceSample[], from: number): { cd: Stats; cl: Stats } | null {
  const win = history.filter((h) => h.time >= from);
  if (win.length < 3) return null;
  return { cd: stats(win.map((h) => h.cd)), cl: stats(win.map((h) => h.cl)) };
}

/** Statistics over the last `passes` flow passes of the history. */
export function trailingStats(history: ForceSample[], passTime: number, passes: number) {
  if (!history.length) return null;
  const from = history[history.length - 1].time - passes * passTime;
  const s = statsFrom(history, from);
  return s && { ...s, from };
}

/** Trailing moving average over `window` seconds of simulated time (O(n) running sums). */
export function movingAverage(history: ForceSample[], window: number): { time: number; cd: number; cl: number }[] {
  const out: { time: number; cd: number; cl: number }[] = [];
  let j = 0, scd = 0, scl = 0;
  for (let i = 0; i < history.length; i++) {
    scd += history[i].cd;
    scl += history[i].cl;
    while (history[j].time < history[i].time - window) {
      scd -= history[j].cd;
      scl -= history[j].cl;
      j++;
    }
    const n = i - j + 1;
    out.push({ time: history[i].time, cd: scd / n, cl: scl / n });
  }
  return out;
}
