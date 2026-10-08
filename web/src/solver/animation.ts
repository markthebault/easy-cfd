import type { VizField } from "./extract";
import type { FlowSolver } from "./gpu";

export interface FlowAnimation {
  version: 1 | 2;
  engine: "webgpu" | "openfoam";
  timeUnit: "s";
  model: "URANS · k–ω SST" | "DDES · k–ω SST";
  frames: { time: number; field: VizField }[];
  sections?: RecordedSection[];
  section?: string;
  server?: { run: string; offset: [number, number, number] };
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

export const ANIMATION_POINTS = 120_000;
export const ANIMATION_FRAMES = 48;
export const ANIMATION_PASSES = 12;

/** Bracket actual solver timestamps, including nonuniform time steps. Never interpolate the loop seam. */
export function frameAt(times: number[], time: number): { index: number; mix: number } {
  const t = Math.max(times[0], Math.min(times.at(-1)!, time));
  let i = 0;
  while (i < times.length - 2 && times[i + 1] <= t) i++;
  return { index: i, mix: (t - times[i]) / Math.max(1e-12, times[i + 1] - times[i]) };
}

/** Continue the computed warm-up field with one physical clock shared by every cell. */
export async function recordFlowAnimation(solver: FlowSolver, sample: () => Promise<VizField>, options: {
  signal?: AbortSignal; deadline?: number; onProgress?: (fraction: number) => void;
} = {}): Promise<FlowAnimation> {
  solver.beginTransient();
  const duration = ANIMATION_PASSES * solver.c.length / solver.c.freestream;
  const frames: FlowAnimation["frames"] = [];
  let state = await solver.readState();
  for (let i = 0; i < ANIMATION_FRAMES; i++) {
    const target = duration * i / (ANIMATION_FRAMES - 1);
    do {
      if (options.signal?.aborted) throw new DOMException("Animation cancelled", "AbortError");
      if (performance.now() > (options.deadline ?? Infinity)) throw new Error("The run reached its time limit while recording flow animation. Increase the run time limit and try again.");
      if (!Number.isFinite(state[0]) || state[0] <= 0 || !Number.isFinite(state[1])) throw new Error("The transient flow solution diverged.");
      if (state[1] >= target) break;
      solver.run(Math.max(1, Math.min(16, Math.floor((target - state[1]) / state[0]))));
      state = await solver.readState();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (true);
    const field = await sample();
    if (options.signal?.aborted) throw new DOMException("Animation cancelled", "AbortError");
    for (const a of [field.u, field.v, field.w, field.p, field.k]) {
      for (let p = 0; p < a.length; p++) if (!field.solid[p] && !Number.isFinite(a[p])) throw new Error("The transient solver produced non-finite flow data.");
    }
    frames.push({ time: state[1], field });
    options.onProgress?.((i + 1) / ANIMATION_FRAMES);
  }
  return { version: 1, engine: "webgpu", timeUnit: "s", model: "URANS · k–ω SST", frames };
}
