// Drives a simulation to the preset's simulated time and turns GPU force history into results.

import { FlowSolver, HISTORY_SLOTS } from "./gpu";
import { prepareCase, type CaseSetup } from "./setup";
import { PRESETS, resolvePreset, type ForceBreakdown, type ForceSample, type RunResult, type Settings, type SolverPart, type Vec3 } from "./types";

export interface Progress {
  stage: "preparing" | "solving" | "finishing";
  fraction: number;
  time: number;
  targetTime: number;
  steps: number;
  history: ForceSample[];
  elapsed: number;
  cells: number;
}

export interface RunOptions {
  onProgress?: (p: Progress) => void;
  /** Called with the live solver about every `snapshotSeconds` of wall time. */
  onSnapshot?: (solver: FlowSolver) => void | Promise<void>;
  snapshotSeconds?: number;
  signal?: AbortSignal;
  /** Override for tests. */
  targetPasses?: number;
  setup?: CaseSetup;
  /** Prepares the grid for one level of a Precise run (e.g. in a worker). */
  prepareLevel?: (settings: Settings) => Promise<CaseSetup>;
  /** Local time stepping toward the steady state (default on). */
  lts?: boolean;
  ltsMaxFactor?: number;
  /** Longest run as a multiple of the requested passes when forces keep drifting (default 2). */
  maxExtension?: number;
  /** Numerical overrides for experiments. */
  solver?: { vcycles?: number; cfl?: number; preSmooth?: number; postSmooth?: number; coarseSweeps?: number };
}

export const LTS_CFL = 0.35;
export const LTS_MAX_FACTOR = 10;

/**
 * Per-cell local time step from the current field (same stability measure as the GPU dt kernel),
 * as a factor relative to the smallest one. Returns the factors, the reference step and the
 * median factor over wall cells (the pace of the flow around the car).
 */
export function timeFactors(c: CaseSetup, vel: Float32Array, turb: Float32Array, maxFactor = LTS_MAX_FACTOR): { fac: Float32Array; dtRef: number; fRef: number } {
  const { NX, NY, NC, aper, flags } = c;
  const w = (a: number, n: number) => c.gridBuffer[c.goff[3] + c.goff[a] + n];
  const dtc = new Float32Array(NC).fill(Infinity);
  let dtRef = Infinity;
  for (let k = 1; k < c.NZ - 1; k++)
    for (let j = 1; j < NY - 1; j++)
      for (let i = 1; i < NX - 1; i++) {
        const idx = i + NX * (j + NY * k);
        if (flags[idx] & 1) continue;
        const dx = w(0, i), dy = w(1, j), dz = w(2, k);
        const th = Math.max(aper[4 * idx + 3], 0.5);
        const u = Math.max(Math.abs(aper[4 * idx] * vel[idx]), Math.abs(aper[4 * (idx - 1)] * vel[idx - 1]));
        const v = Math.max(Math.abs(aper[4 * idx + 1] * vel[NC + idx]), Math.abs(aper[4 * (idx - NX) + 1] * vel[NC + idx - NX]));
        const ww = Math.max(Math.abs(aper[4 * idx + 2] * vel[2 * NC + idx]), Math.abs(aper[4 * (idx - NX * NY) + 2] * vel[2 * NC + idx - NX * NY]));
        const nuE = 1.5e-5 + turb[2 * NC + idx];
        // 25 % headroom for velocities that grow before the next rebuild.
        const L = 1.25 * ((u / dx + v / dy + ww / dz) / th + 2 * nuE * (1 / dx ** 2 + 1 / dy ** 2 + 1 / dz ** 2));
        const d = LTS_CFL / Math.max(L, 1e-6);
        dtc[idx] = d;
        if (d < dtRef) dtRef = d;
      }
  const fac = new Float32Array(NC).fill(1);
  for (let idx = 0; idx < NC; idx++) if (Number.isFinite(dtc[idx])) fac[idx] = Math.min(dtc[idx] / dtRef, maxFactor);
  // Ghost layers copy their interior neighbour so boundary faces use the adjacent step.
  const NZ = c.NZ;
  for (let k = 0; k < NZ; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        if (i > 0 && j > 0 && k > 0 && i < NX - 1 && j < NY - 1 && k < NZ - 1) continue;
        const ci = Math.min(Math.max(i, 1), NX - 2), cj = Math.min(Math.max(j, 1), NY - 2), ck = Math.min(Math.max(k, 1), NZ - 2);
        fac[i + NX * (j + NY * k)] = fac[ci + NX * (cj + NY * ck)];
      }
  const near: number[] = [];
  for (let q = 0; q < c.faceCount; q++) near.push(fac[c.faces[2 * q]]);
  near.sort((a, b) => a - b);
  const fRef = near.length ? near[Math.floor(near.length / 2)] : 1;
  return { fac, dtRef, fRef };
}

interface RawRecord {
  time: number;
  step: number;
  f: number[]; // 12 forces per unit density
}

function decodeHistory(buf: Float32Array, fromStep: number, toStep: number): RawRecord[] {
  const out: RawRecord[] = [];
  const first = Math.max(fromStep + 1, toStep - HISTORY_SLOTS + 1);
  for (let s = first; s <= toStep; s++) {
    const o = (s % HISTORY_SLOTS) * 16;
    if (Math.round(buf[o + 2]) !== s) continue;
    out.push({ time: buf[o], step: s, f: Array.from(buf.subarray(o + 4, o + 16)) });
  }
  return out;
}

/**
 * Run a simulation. Fast, Medium and Custom solve one grid. Precise solves the Medium grid and a
 * finer one and reports the mean of the two, with their difference as a mesh-sensitivity band
 * (separation on car rear ends shifts with resolution; averaging two levels halves that noise).
 */
export async function runSimulation(
  device: GPUDevice,
  parts: SolverPart[],
  settings: Settings,
  opts: RunOptions = {},
): Promise<{ result: RunResult; solver: FlowSolver; setup: CaseSetup }> {
  if (settings.quality !== "precise") return runLevel(device, parts, settings, opts);
  const started = performance.now();
  const level = (p: typeof PRESETS.medium): Settings => ({ ...settings, quality: "custom", custom_cells: p.cellsPerLength, custom_passes: p.passes });
  const coarse = level(PRESETS.medium);
  const fine = level(PRESETS.precise);
  // Share of the work: roughly proportional to cells × steps.
  const w0 = 0.35;
  const scale = (f: number, a: number, b: number) => a + (b - a) * f;
  const first = await runLevel(device, parts, coarse, {
    ...opts,
    setup: opts.prepareLevel ? await opts.prepareLevel(coarse) : undefined,
    onProgress: (p) => opts.onProgress?.({ ...p, fraction: scale(p.fraction, 0, w0), stage: p.stage === "finishing" ? "solving" : p.stage }),
  });
  first.solver.destroy();
  const second = await runLevel(device, parts, fine, {
    ...opts,
    setup: opts.setup ?? (opts.prepareLevel ? await opts.prepareLevel(fine) : undefined),
    onProgress: (p) => opts.onProgress?.({ ...p, fraction: scale(p.fraction, w0, 1) }),
  });
  const a = first.result, b = second.result;
  const mean = (x: number, y: number) => 0.5 * (x + y);
  const avg = (u: [number, number, number], v: [number, number, number]): [number, number, number] => [mean(u[0], v[0]), mean(u[1], v[1]), mean(u[2], v[2])];
  const result: RunResult = {
    ...b,
    cd: mean(a.cd, b.cd),
    cl: mean(a.cl, b.cl),
    cs: mean(a.cs, b.cs),
    drag: mean(a.drag, b.drag),
    lift: mean(a.lift, b.lift),
    side: mean(a.side, b.side),
    downforce: mean(a.downforce, b.downforce),
    breakdown: {
      bodyPressure: avg(a.breakdown.bodyPressure, b.breakdown.bodyPressure),
      bodyViscous: avg(a.breakdown.bodyViscous, b.breakdown.bodyViscous),
      wheelPressure: avg(a.breakdown.wheelPressure, b.breakdown.wheelPressure),
      wheelViscous: avg(a.breakdown.wheelViscous, b.breakdown.wheelViscous),
    },
    settled: a.settled && b.settled,
    steps: a.steps + b.steps,
    wallSeconds: (performance.now() - started) / 1000,
    levels: [
      { label: "Medium grid", cells: a.cells, cd: a.cd, cl: a.cl, drag: a.drag, lift: a.lift },
      { label: "Fine grid", cells: b.cells, cd: b.cd, cl: b.cl, drag: b.drag, lift: b.lift },
    ],
    meshSensitivity: { dCd: b.cd - a.cd, dCl: b.cl - a.cl },
    cdBand: Math.hypot(a.cdBand ?? 0, b.cdBand ?? 0) / 2,
    clBand: Math.hypot(a.clBand ?? 0, b.clBand ?? 0) / 2,
    warnings: [...new Set([...a.warnings, ...b.warnings])],
  };
  const rel = Math.abs(b.cd - a.cd) / Math.max(Math.abs(result.cd), 1e-6);
  if (rel > 0.1)
    result.warnings.push(`The two grid levels differ by ${(rel * 100).toFixed(0)} % in drag. The flow around this shape is sensitive to resolution; treat differences between designs smaller than that with caution.`);
  return { result, solver: second.solver, setup: second.setup };
}

async function runLevel(
  device: GPUDevice,
  parts: SolverPart[],
  settings: Settings,
  opts: RunOptions = {},
): Promise<{ result: RunResult; solver: FlowSolver; setup: CaseSetup }> {
  const started = performance.now();
  const preset = resolvePreset(settings);
  opts.onProgress?.({ stage: "preparing", fraction: 0, time: 0, targetTime: 1, steps: 0, history: [], elapsed: 0, cells: 0 });
  const setup = opts.setup ?? prepareCase(parts, settings);
  const solver = new FlowSolver(device, setup, { cfl: opts.solver?.cfl });
  const o = opts.solver ?? {};
  if (o.vcycles !== undefined) solver.vcycles = o.vcycles;
  if (o.preSmooth !== undefined) solver.preSmooth = o.preSmooth;
  if (o.postSmooth !== undefined) solver.postSmooth = o.postSmooth;
  if (o.coarseSweeps !== undefined) solver.coarseSweeps = o.coarseSweeps;
  solver.initialProjection();
  const U = setup.freestream;
  const L = setup.length;
  const baseTarget = ((opts.targetPasses ?? preset.passes) * L) / U;
  // Runs are extended (up to twice the requested length) while forces keep drifting.
  // Fast stays exploratory and is never extended.
  const maxExt = opts.maxExtension ?? (settings.quality === "fast" ? 1 : 2);
  const maxTarget = Math.min(baseTarget * maxExt, baseTarget + (10 * L) / U);
  let targetTime = baseTarget;
  const q = 0.5 * settings.density * U * U;
  const qA = q * settings.reference_area;
  const raw: RawRecord[] = [];
  const samples: ForceSample[] = [];
  let lastStep = 0;
  let time = 0; // pseudo time at the pace of the flow around the car
  let batch = 4;
  const lts = opts.lts ?? true;
  // Segments mapping GPU time (reference steps) to pseudo time: tau = tau0 + (t - t0) * f.
  const segments: { t0: number; tau0: number; f: number }[] = [{ t0: 0, tau0: 0, f: 1 }];
  const tauOf = (t: number) => {
    let sg = segments[0];
    for (const q of segments) if (t >= q.t0) sg = q;
    return sg.tau0 + (t - sg.t0) * sg.f;
  };
  const passTime = L / U;
  let nextRebuild = 0.5 * passTime;
  const ltsLog: { step: number; dtRef: number; fRef: number; dtBefore: number }[] = [];
  let lastSnapshot = performance.now();
  const toSample = (r: RawRecord): ForceSample => {
    const fx = r.f[0] + r.f[3] + r.f[6] + r.f[9];
    r.time = tauOf(r.time);
    const fy = r.f[1] + r.f[4] + r.f[7] + r.f[10];
    const fz = r.f[2] + r.f[5] + r.f[8] + r.f[11];
    const rho = settings.density;
    return { time: r.time, step: r.step, cd: (rho * fx) / qA, cl: (rho * fz) / qA, cs: (rho * fy) / qA };
  };
  try {
   for (;;) {
    while (time < targetTime) {
      if (opts.signal?.aborted) throw new DOMException("Simulation cancelled", "AbortError");
      const t0 = performance.now();
      // Keep roughly one batch in flight; adapt batch size to ~120 ms of GPU work.
      solver.run(batch);
      const state = await solver.readState();
      const dtWall = performance.now() - t0;
      batch = Math.max(1, Math.min(64, Math.round(batch * Math.min(2, Math.max(0.5, 120 / Math.max(dtWall, 1))))));
      if (!Number.isFinite(state[1]) || !Number.isFinite(state[0]) || state[0] <= 0)
        throw new Error("The flow solution diverged. Try a finer mesh or check the geometry for tiny gaps.");
      time = tauOf(state[1]);
      const step = Math.round(state[2]);
      if (lts && time >= nextRebuild) {
        const f = await solver.readFields();
        const tf = timeFactors(setup, f.vel, f.turb, opts.ltsMaxFactor);
        solver.setTimeFactors(tf.fac, tf.dtRef);
        const cur = await solver.readState();
        // From here the GPU clock advances by dtRef per step and the car region by dtRef·fRef.
        segments.push({ t0: cur[1], tau0: tauOf(cur[1]), f: tf.fRef });
        ltsLog.push({ step, dtRef: tf.dtRef, fRef: tf.fRef, dtBefore: cur[0] });
        nextRebuild = time + passTime;
      }
      if (step - lastStep > HISTORY_SLOTS / 2 || time >= targetTime || samples.length === 0 || step - lastStep > 40) {
        const hist = await solver.readHistory();
        const recs = decodeHistory(hist, lastStep, step);
        for (const r of recs) {
          if (r.f.some((v) => !Number.isFinite(v)))
            throw new Error("The flow solution diverged. Try a finer mesh or check the geometry for tiny gaps.");
          raw.push(r);
          samples.push(toSample(r));
        }
        lastStep = step;
      }
      opts.onProgress?.({
        stage: "solving",
        fraction: Math.min(1, time / targetTime),
        time,
        targetTime,
        steps: step,
        history: samples,
        elapsed: (performance.now() - started) / 1000,
        cells: setup.grid.cells,
      });
      if (opts.onSnapshot && performance.now() - lastSnapshot > (opts.snapshotSeconds ?? 2) * 1000) {
        await opts.onSnapshot(solver);
        lastSnapshot = performance.now();
      }
    }
    if (targetTime >= maxTarget * 0.999 || !drifting(samples, targetTime, preset.averageFraction)) break;
    targetTime = Math.min(maxTarget, targetTime + 0.25 * baseTarget);
   }
  } catch (e) {
    solver.destroy();
    throw e;
  }
  opts.onProgress?.({ stage: "finishing", fraction: 1, time, targetTime, steps: solver.steps, history: samples, elapsed: (performance.now() - started) / 1000, cells: setup.grid.cells });
  const result = summarise(raw, samples, setup, settings, preset.averageFraction, targetTime);
  result.wallSeconds = (performance.now() - started) / 1000;
  if (targetTime > baseTarget * 1.001) {
    result.extendedPasses = ((targetTime - baseTarget) * U) / L;
    result.warnings = result.warnings.filter((w) => !w.startsWith("Forces were still changing"));
    result.warnings.unshift(
      `Forces were still drifting, so the run was extended by ${result.extendedPasses.toFixed(1)} flow passes.` +
        (result.settled ? "" : " They had not settled at the maximum length; the ± bands show the remaining spread."),
    );
  }
  (result as RunResult & { lts?: unknown }).lts = ltsLog;
  return { result, solver, setup };
}

/**
 * True when the mean of Cd or Cl still moves between the two halves of the averaging window
 * (Cd by more than 1 %, Cl by more than 0.01 or 4 %).
 */
export function drifting(samples: ForceSample[], targetTime: number, averageFraction: number): boolean {
  const win = samples.filter((s) => s.time >= targetTime * (1 - averageFraction));
  if (win.length < 40) return false;
  const half = Math.floor(win.length / 2);
  const mean = (a: ForceSample[], k: "cd" | "cl") => a.reduce((n, s) => n + s[k], 0) / a.length;
  const a = win.slice(0, half), b = win.slice(half);
  const cd = mean(win, "cd"), cl = mean(win, "cl");
  return Math.abs(mean(b, "cd") - mean(a, "cd")) > 0.01 * Math.max(Math.abs(cd), 0.05) ||
    Math.abs(mean(b, "cl") - mean(a, "cl")) > Math.max(0.01, 0.04 * Math.abs(cl));
}

export function summarise(
  raw: RawRecord[],
  samples: ForceSample[],
  setup: CaseSetup,
  settings: Settings,
  averageFraction: number,
  targetTime: number,
): RunResult {
  const U = setup.freestream;
  const q = 0.5 * settings.density * U * U;
  const qA = q * settings.reference_area;
  const tStart = targetTime * (1 - averageFraction);
  // Time-weighted average over the final window.
  let wsum = 0;
  const acc = new Array(12).fill(0);
  let prev = raw.length ? raw[0].time : 0;
  const window = raw.filter((r) => r.time >= tStart);
  const use = window.length > 10 ? window : raw.slice(-Math.max(1, Math.floor(raw.length * averageFraction)));
  prev = use.length ? use[0].time - (use.length > 1 ? use[1].time - use[0].time : 0) : 0;
  for (const r of use) {
    const w = Math.max(r.time - prev, 0);
    prev = r.time;
    wsum += w;
    for (let m = 0; m < 12; m++) acc[m] += w * r.f[m];
  }
  const rho = settings.density;
  const avg = acc.map((v) => (rho * v) / Math.max(wsum, 1e-30));
  const vec = (o: number): Vec3 => [avg[o], avg[o + 1], avg[o + 2]];
  const breakdown: ForceBreakdown = { bodyPressure: vec(0), bodyViscous: vec(3), wheelPressure: vec(6), wheelViscous: vec(9) };
  const drag = avg[0] + avg[3] + avg[6] + avg[9];
  const side = avg[1] + avg[4] + avg[7] + avg[10];
  const lift = avg[2] + avg[5] + avg[8] + avg[11];
  const cd = drag / qA;
  const cl = lift / qA;
  const cs = side / qA;
  // Settling: spread of a moving average over the last window, relative to the mean.
  const win = samples.filter((s) => s.time >= tStart);
  const spread = (key: "cd" | "cl") => {
    if (win.length < 20) return Infinity;
    const chunk = Math.max(1, Math.floor(win.length / 6));
    const means: number[] = [];
    for (let i = 0; i + chunk <= win.length; i += chunk) {
      let s = 0;
      for (let j = i; j < i + chunk; j++) s += win[j][key];
      means.push(s / chunk);
    }
    return Math.max(...means) - Math.min(...means);
  };
  // Spread of the window: half the range of six sub-window means (an indicative ± band).
  const band = (key: "cd" | "cl") => {
    if (win.length < 12) return NaN;
    const chunk = Math.floor(win.length / 6);
    const means: number[] = [];
    for (let i = 0; i + chunk <= win.length; i += chunk) means.push(win.slice(i, i + chunk).reduce((n, s) => n + s[key], 0) / chunk);
    return 0.5 * (Math.max(...means) - Math.min(...means));
  };
  const cdSpan = spread("cd");
  const clSpan = spread("cl");
  const settled = cdSpan <= 0.02 * Math.max(Math.abs(cd), 0.01) * 2.5 && clSpan <= 0.02 * Math.max(Math.abs(cl), 0.05) * 5;
  const [, , y0, y1, , z1] = setup.domain;
  const blockage = settings.reference_area / ((y1 - y0) * z1);
  const warnings: string[] = [];
  if (!settled) warnings.push("Forces were still changing over the averaging window. Treat them as provisional or run longer.");
  if (blockage > 0.05) warnings.push(`Tunnel blockage is ${(blockage * 100).toFixed(1)} %. Above 5 % the walls speed up the flow around the car.`);
  if (setup.thinParts.length)
    warnings.push(`Thinner than about 1.5 grid cells, modelled as zero-thickness walls: ${setup.thinParts.join(", ")}. Their forces are approximate; Precise resolves them better.`);
  if (setup.sealedCells > 0) warnings.push("Enclosed air pockets inside the geometry were filled as solid.");
  return {
    cd,
    cl,
    cs,
    drag,
    lift,
    side,
    downforce: -lift,
    breakdown,
    history: samples,
    settled,
    cdSpan,
    cdBand: band("cd"),
    clBand: band("cl"),
    clSpan,
    cells: setup.grid.cells,
    steps: samples.length ? samples[samples.length - 1].step : 0,
    simulatedTime: samples.length ? samples[samples.length - 1].time : 0,
    wallSeconds: 0,
    freestream: U,
    dynamicPressure: q,
    domain: setup.domain,
    blockage,
    warnings,
  };
}
