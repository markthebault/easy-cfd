// Headless harness used by validation/run-validation.mjs. Not linked from the app.
import { computeLease } from "./engine/computeLease";
import { parseSTL } from "./geometry/stl";
import { requestDevice } from "./solver/gpu";
import { runSimulation } from "./solver/run";
import { prepareCase } from "./solver/setup";
import { DEFAULT_SETTINGS, type Settings, type SolverPart } from "./solver/types";

interface BenchPart {
  url: string;
  name: string;
  role: "body" | "wheel";
  wheel?: { center: [number, number, number]; radius: number } | null;
  active?: boolean;
  detail?: "auto" | "always" | "off";
}

interface BenchSpec {
  parts: BenchPart[];
  settings: Partial<Settings>;
  targetPasses?: number;
  lts?: boolean;
  ltsMaxFactor?: number;
  solver?: { vcycles?: number; cfl?: number; preSmooth?: number; postSmooth?: number; coarseSweeps?: number };
}

const log = (m: string) => {
  const el = document.getElementById("log")!;
  el.textContent += "\n" + m;
};

let devicePromise: ReturnType<typeof requestDevice> | null = null;

async function run(spec: BenchSpec) {
  const controller=new AbortController();
  const release=await computeLease(controller.signal,()=>controller.abort(),Boolean((window as unknown as {cfdBenchBackend?:boolean}).cfdBenchBackend));
  try {
  devicePromise ??= requestDevice();
  const { device, adapterName } = await devicePromise;
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const t0 = performance.now();
  const setup = prepareCase(parts, settings);
  const prepSeconds = (performance.now() - t0) / 1000;
  log(`grid ${setup.grid.x.n}x${setup.grid.y.n}x${setup.grid.z.n} = ${setup.grid.cells} cells, h=${setup.grid.h.toFixed(4)}, hmin=${(setup.grid.hmin ?? 0).toFixed(4)}, detail ${setup.detail.ratio}× (${setup.detail.zones.length} zones), thin [${setup.thinParts.join(", ")}], thickened [${setup.thickenedParts.map((t) => `${t.name}+${t.mm}mm`).join(", ")}], faces ${setup.faceCount}, prep ${prepSeconds.toFixed(1)} s`);
  let lastLog = 0;
  const { result, solver } = await runSimulation(device, parts, settings, {
    setup,
    signal:controller.signal,
    targetPasses: spec.targetPasses,
    solver: spec.solver,
    lts: spec.lts,
    ltsMaxFactor: spec.ltsMaxFactor,
    onProgress: (p) => {
      if (p.elapsed - lastLog > 5) {
        lastLog = p.elapsed;
        const h = p.history[p.history.length - 1];
        log(`t=${p.time.toFixed(3)}/${p.targetTime.toFixed(3)} steps=${p.steps} cd=${h?.cd.toFixed(4)} cl=${h?.cl.toFixed(4)} ${p.elapsed.toFixed(0)} s`);
      }
    },
  });
  solver.destroy();
  const every = Math.max(1, Math.floor(result.history.length / 400));
  return {
    adapter: adapterName,
    prepSeconds,
    grid: [setup.grid.x.n, setup.grid.y.n, setup.grid.z.n],
    h: setup.grid.h,
    faces: setup.faceCount,
    thinParts: setup.thinParts,
    thickenedParts: setup.thickenedParts,
    detailZones: setup.detail.zones,
    gridAxes: [setup.grid.x.n, setup.grid.y.n, setup.grid.z.n],
    sealedCells: setup.sealedCells,
    voxelFrontalArea: setup.voxelFrontalArea,
    timings: setup.timings,
    ...result,
    history: result.history.filter((_, i) => i % every === 0),
  };
  } finally {await release();}
}

(window as unknown as { cfdBench: unknown }).cfdBench = { run, ready: true };

// Step-by-step diagnostics: field extrema and divergence after each step.
async function debug(spec: BenchSpec, steps: number, opts: { vcycles?: number; probe?: number[][] } = {}) {
  devicePromise ??= requestDevice();
  const { device } = await devicePromise;
  const { FlowSolver } = await import("./solver/gpu");
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const setup = prepareCase(parts, settings);
  const solver = new FlowSolver(device, setup);
  if (opts.vcycles) solver.vcycles = opts.vcycles;
  const out: unknown[] = [];
  solver.initialProjection();
  const { NX, NY, NC } = setup;
  const stats = async () => {
    const f = await solver.readFields();
    const div = await solver.readDivergence();
    const st = await solver.readState();
    const ext = (a: Float32Array, o: number, n: number) => {
      let mn = Infinity, mx = -Infinity, at = 0, amn = 0, nan = 0;
      for (let i = o; i < o + n; i++) {
        const v = a[i];
        if (!Number.isFinite(v)) { nan++; continue; }
        if (v < mn) { mn = v; amn = i - o; }
        if (v > mx) { mx = v; at = i - o; }
      }
      const loc = (q: number) => [q % NX, Math.floor(q / NX) % NY, Math.floor(q / (NX * NY)), setup.flags[q] & 1];
      return { mn: +mn.toPrecision(4), mx: +mx.toPrecision(4), at: loc(at), atMin: loc(amn), nan };
    };
    let divMax = 0, divAt = 0;
    for (let i = 0; i < NC; i++) if (Math.abs(div[i]) > divMax) { divMax = Math.abs(div[i]); divAt = i; }
    return {
      dt: st[0], time: st[1], step: st[2],
      u: ext(f.vel, 0, NC), v: ext(f.vel, NC, NC), w: ext(f.vel, 2 * NC, NC),
      p: ext(f.pres, 0, NC), k: ext(f.turb, 0, NC), om: ext(f.turb, NC, NC), nut: ext(f.turb, 2 * NC, NC),
      divMaxTimesDt: divMax * st[0], divAt: [divAt % NX, Math.floor(divAt / NX) % NY, Math.floor(divAt / (NX * NY))],
    };
  };
  const probe = async (cells: number[][]) => {
    const f = await solver.readFields();
    return cells.map(([i, j, k]) => {
      const q = i + NX * (j + NY * k);
      return { c: [i, j, k], u: f.vel[q], v: f.vel[NC + q], w: f.vel[2 * NC + q], p: f.pres[q], k: f.turb[q], om: f.turb[NC + q], nut: f.turb[2 * NC + q] };
    });
  };
  const probeCells = (opts as { probe?: number[][] }).probe;
  out.push({ dims: [NX, NY, setup.NZ], h: setup.grid.h, ...(await stats()) });
  if (probeCells) out.push({ probe: await probe(probeCells) });
  for (let s = 0; s < steps; s++) {
    solver.run(1);
    out.push(await stats());
    if (probeCells) out.push({ probe: await probe(probeCells) });
  }
  solver.destroy();
  return out;
}

(window as unknown as { cfdBench: Record<string, unknown> }).cfdBench.debug = debug;

async function mg(spec: BenchSpec, cycles: number, variant: { pre?: number; post?: number; coarse?: number; alpha?: number } = {}) {
  devicePromise ??= requestDevice();
  const { device } = await devicePromise;
  const { FlowSolver } = await import("./solver/gpu");
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const setup = prepareCase(parts, settings);
  const solver = new FlowSolver(device, setup, { correctionFactor: variant.alpha });
  if (variant.pre !== undefined) solver.preSmooth = variant.pre;
  if (variant.post !== undefined) solver.postSmooth = variant.post;
  if (variant.coarse !== undefined) solver.coarseSweeps = variant.coarse;
  const lv = setup.levels[0];
  const { NX, NY, NC, coef } = lv;
  const rhs = new Float32Array(NC);
  // Smooth-ish random right-hand side on fluid cells, with zero mean not required (Dirichlet outlet).
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const diag = (i: number) => coef[4 * i] + coef[4 * i + 1] + coef[4 * i + 2] + coef[4 * i + 3] + coef[4 * (i - 1)] + coef[4 * (i - NX) + 1] + coef[4 * (i - NX * NY) + 2];
  for (let i = NX * NY + NX + 1; i < NC - NX * NY - NX - 1; i++) if (diag(i) > 0) rhs[i] = rnd();
  const res = (phi: Float32Array) => {
    let s = 0;
    for (let i = NX * NY + NX + 1; i < NC - NX * NY - NX - 1; i++) {
      const d = diag(i);
      if (d <= 0) continue;
      const a = coef[4 * i] * phi[i + 1] + coef[4 * (i - 1)] * phi[i - 1] + coef[4 * i + 1] * phi[i + NX] + coef[4 * (i - NX) + 1] * phi[i - NX] + coef[4 * i + 2] * phi[i + NX * NY] + coef[4 * (i - NX * NY) + 2] * phi[i - NX * NY] - d * phi[i];
      s += (rhs[i] - a) ** 2;
    }
    return Math.sqrt(s);
  };
  const r0 = res(new Float32Array(NC));
  const phis = await solver.mgTest(rhs, cycles);
  solver.destroy();
  return { r0, levels: setup.levels.map((l) => [l.nx, l.ny, l.nz]), residuals: phis.map(res) };
}
(window as unknown as { cfdBench: Record<string, unknown> }).cfdBench.mg = mg;

// Throughput: time `steps` steps submitted in batches, one sync at the end.
async function perf(spec: BenchSpec, steps: number, variant: { vcycles?: number; coarse?: number; pre?: number; post?: number; split?: boolean } = {}) {
  devicePromise ??= requestDevice();
  const { device } = await devicePromise;
  const { FlowSolver } = await import("./solver/gpu");
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const setup = prepareCase(parts, settings);
  const solver = new FlowSolver(device, setup);
  Object.assign(solver, {
    ...(variant.vcycles !== undefined && { vcycles: variant.vcycles }),
    ...(variant.coarse !== undefined && { coarseSweeps: variant.coarse }),
    ...(variant.pre !== undefined && { preSmooth: variant.pre }),
    ...(variant.post !== undefined && { postSmooth: variant.post }),
    ...(variant.split !== undefined && { splitMomentum: variant.split }),
  });
  solver.initialProjection();
  solver.run(5);
  await solver.readState();
  const kernels = await solver.kernelTimes(10);
  const t0 = performance.now();
  for (let s = 0; s < steps; s += 10) solver.run(10);
  const st = await solver.readState();
  const ms = (performance.now() - t0) / steps;
  solver.destroy();
  return { cells: setup.grid.cells, msPerStep: ms, dt: st[0], time: st[1], kernels };
}
(window as unknown as { cfdBench: Record<string, unknown> }).cfdBench.perf = perf;

// Run a case, then return mid-plane slices (y = 0 and z = mid-height) of several fields for images.
async function slices(spec: BenchSpec, planes: { axis: "y" | "z" | "x"; at: number }[]) {
  devicePromise ??= requestDevice();
  const { device } = await devicePromise;
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const setup = prepareCase(parts, settings);
  const { result, solver } = await runSimulation(device, parts, settings, { setup, targetPasses: spec.targetPasses });
  const f = await solver.readFields();
  solver.destroy();
  const { NX, NY, NC } = setup;
  const g = setup.grid;
  const out = planes.map(({ axis, at }) => {
    // Sample on the native grid in the viewing window around the car.
    const L = setup.length;
    const cols: number[] = [], rows: number[] = [];
    const pick = (centers: Float64Array, lo: number, hi: number, list: number[]) => {
      centers.forEach((c, i) => { if (c >= lo && c <= hi) list.push(i + 1); });
    };
    const loc = (centers: Float64Array, v: number) => { let b = 0; centers.forEach((c, i) => { if (Math.abs(c - v) < Math.abs(centers[b] - v)) b = i; }); return b + 1; };
    const xr: [number, number] = [setup.low[0] - 0.5 * L, setup.high[0] + 1.5 * L];
    const yr: [number, number] = [setup.low[1] - 0.3 * L, setup.high[1] + 0.3 * L];
    const zr: [number, number] = [0, setup.high[2] + 0.4 * L];
    let fixed: number;
    if (axis === "y") { pick(g.x.centers, ...xr, cols); pick(g.z.centers, ...zr, rows); fixed = loc(g.y.centers, at); }
    else if (axis === "z") { pick(g.x.centers, ...xr, cols); pick(g.y.centers, ...yr, rows); fixed = loc(g.z.centers, at); }
    else { pick(g.y.centers, ...yr, cols); pick(g.z.centers, ...zr, rows); fixed = loc(g.x.centers, at); }
    const fields: Record<string, number[]> = { speed: [], p: [], nut: [], k: [], w: [], solid: [] };
    for (const r of rows) for (const c of cols) {
      const [i, j, k] = axis === "y" ? [c, fixed, r] : axis === "z" ? [c, r, fixed] : [fixed, c, r];
      const idx = i + NX * (j + NY * k);
      const s = setup.flags[idx] & 1;
      const u = 0.5 * (f.vel[idx] + f.vel[idx - 1]);
      const v = 0.5 * (f.vel[NC + idx] + f.vel[NC + idx - NX]);
      const w = 0.5 * (f.vel[2 * NC + idx] + f.vel[2 * NC + idx - NX * NY]);
      fields.speed.push(s ? NaN : Math.hypot(u, v, w));
      fields.p.push(s ? NaN : f.pres[idx]);
      fields.nut.push(s ? NaN : f.turb[2 * NC + idx]);
      fields.k.push(s ? NaN : f.turb[idx]);
      fields.w.push(s ? NaN : w);
      fields.solid.push(s);
    }
    const colCoord = cols.map((c) => (axis === "x" ? g.y.centers[c - 1] : g.x.centers[c - 1]));
    const rowCoord = rows.map((r) => (axis === "z" ? g.y.centers[r - 1] : g.z.centers[r - 1]));
    return { axis, at, width: cols.length, height: rows.length, fields, colCoord, rowCoord };
  });
  // Per wall cell: centre, wall area vector, pressure, part.
  const wallCells: number[][] = [];
  for (let q = 0; q < setup.faceCount; q++) {
    const idx = setup.faces[2 * q];
    const i = idx % NX, j = Math.floor(idx / NX) % NY, k = Math.floor(idx / (NX * NY));
    wallCells.push([g.x.centers[i - 1], g.y.centers[j - 1], g.z.centers[k - 1], setup.wall[4 * idx], setup.wall[4 * idx + 1], setup.wall[4 * idx + 2], setup.wall[4 * idx + 3], f.pres[idx], setup.faces[2 * q + 1] & 255, setup.aper[4 * idx + 3]]);
  }
  return { cd: result.cd, cl: result.cl, breakdown: result.breakdown, history: result.history.filter((_, i) => i % 20 === 0), planes: out, wallCells };
}
(window as unknown as { cfdBench: Record<string, unknown> }).cfdBench.slices = slices;

// Geometry data (apertures, θ, wall vectors, merge links) around a cell.
async function cellInfo(spec: BenchSpec, cells: number[][]) {
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const s = prepareCase(parts, settings);
  const out: unknown[] = [];
  for (const [ci, cj, ck] of cells)
    for (let dk = -1; dk <= 1; dk++)
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const i = ci + di, j = cj + dj, k = ck + dk;
          const g = i + s.NX * (j + s.NY * k);
          out.push({
            c: [i, j, k], xyz: [s.grid.x.centers[i - 1], s.grid.y.centers[j - 1], s.grid.z.centers[k - 1]].map((v) => +v.toFixed(3)),
            aper: Array.from(s.aper.subarray(4 * g, 4 * g + 4)).map((v) => +v.toFixed(3)),
            wall: Array.from(s.wall.subarray(4 * g, 4 * g + 4)).map((v) => +v.toFixed(5)),
            solid: s.flags[g] & 1, part: (s.flags[g] >> 8) & 255, link: (s.flags[g] >> 16) & 7,
          });
        }
  return { thin: s.thinParts, merged: s.mergedCells, out };
}
(window as unknown as { cfdBench: Record<string, unknown> }).cfdBench.cellInfo = cellInfo;

// Which cells limit the time step (mirrors the dtReduce kernel on the CPU).
async function dtLimiters(spec: BenchSpec, steps: number) {
  devicePromise ??= requestDevice();
  const { device } = await devicePromise;
  const { FlowSolver } = await import("./solver/gpu");
  const parts: SolverPart[] = [];
  for (const p of spec.parts) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    parts.push({ id: p.name, name: p.name, role: p.role, wheel: p.wheel ?? null, positions: parseSTL(buf), active: p.active, detail: p.detail });
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...spec.settings };
  const s = prepareCase(parts, settings);
  const solver = new FlowSolver(device, s);
  solver.initialProjection();
  for (let i = 0; i < steps; i += 20) { solver.run(20); await solver.readState(); }
  const f = await solver.readFields();
  const st = await solver.readState();
  solver.destroy();
  const { NX, NY, NC } = s;
  const gw = (a: number, n: number) => s.gridBuffer[s.goff[3] + s.goff[a] + n];
  const list: { l: number; conv: number; diff: number; c: number[]; theta: number; link: number; u: number[]; nut: number }[] = [];
  for (let idx = NX * NY; idx < NC - NX * NY; idx++) {
    if (s.flags[idx] & 1) continue;
    const i = idx % NX, j = Math.floor(idx / NX) % NY, k = Math.floor(idx / (NX * NY));
    if (i < 1 || j < 1 || i > NX - 2 || j > NY - 2) continue;
    const dx = gw(0, i), dy = gw(1, j), dz = gw(2, k);
    const a = s.aper;
    const th = Math.max(a[4 * idx + 3], 0.5);
    const u = Math.max(Math.abs(a[4 * idx] * f.vel[idx]), Math.abs(a[4 * (idx - 1)] * f.vel[idx - 1]));
    const v = Math.max(Math.abs(a[4 * idx + 1] * f.vel[NC + idx]), Math.abs(a[4 * (idx - NX) + 1] * f.vel[NC + idx - NX]));
    const w = Math.max(Math.abs(a[4 * idx + 2] * f.vel[2 * NC + idx]), Math.abs(a[4 * (idx - NX * NY) + 2] * f.vel[2 * NC + idx - NX * NY]));
    const nut = f.turb[2 * NC + idx];
    const conv = (u / dx + v / dy + w / dz) / th;
    const diff = 2 * (1.5e-5 + nut) * (1 / dx ** 2 + 1 / dy ** 2 + 1 / dz ** 2);
    list.push({ l: conv + diff, conv, diff, c: [i, j, k], theta: a[4 * idx + 3], link: (s.flags[idx] >> 16) & 7, u: [f.vel[idx], f.vel[NC + idx], f.vel[2 * NC + idx]].map((x) => +x.toFixed(1)), nut });
  }
  list.sort((p, q) => q.l - p.l);
  return { dt: st[0], top: list.slice(0, 15), median: list[Math.floor(list.length / 2)].l };
}
(window as unknown as { cfdBench: Record<string, unknown> }).cfdBench.dtLimiters = dtLimiters;
