import type { VizField } from "./extract";

export interface FlowAnimation {
  version: 1 | 2;
  engine: "openfoam";
  timeUnit: "s";
  model: "URANS · k–ω SST" | "DDES · k–ω SST";
  frames: { time: number; field: VizField }[];
  sections?: RecordedSection[];
  section?: string;
  server?: { run: string; offset: [number, number, number]; backend?: string };
}

export interface RecordedSection {
  id: string;
  label: string;
  axis: 0 | 1 | 2;
  position: number;
  origin: [number, number, number];
  spacing: [number, number, number];
  dims: [number, number, number];
}

/** Bracket actual solver timestamps, including nonuniform time steps. Never interpolate the loop seam. */
export function frameAt(times: number[], time: number): { index: number; mix: number } {
  const t = Math.max(times[0], Math.min(times.at(-1)!, time));
  let i = 0;
  while (i < times.length - 2 && times[i + 1] <= t) i++;
  return { index: i, mix: (t - times[i]) / Math.max(1e-12, times[i + 1] - times[i]) };
}
