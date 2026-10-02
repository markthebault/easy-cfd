// WebGPU orchestration of the flow solver. One step:
//   boundary(u) → momentum predictor → boundary(u*) → ∇·u* → multigrid φ → projection
//   → boundary(k, ω) → SST update → forces → (every few steps) stable time step.

import { WG } from "./kernels/common";
import { bcVelocityWGSL, correctWGSL, divergenceWGSL, dtFinalizeWGSL, dtReduceWGSL, momentumWGSL } from "./kernels/flow";
import { forcesSumWGSL, forcesWGSL, partForcesWGSL, prolongWGSL, restrictWGSL, smoothWGSL } from "./kernels/pressure";
import { bcTurbWGSL, turbulenceWGSL, solveSstWGSL, finishSstWGSL } from "./kernels/turbulence";
import { assembleMomentumWGSL, solveMomentumWGSL, momentumPressureWGSL, coarsenMomentumPressureWGSL } from "./kernels/simple";
import { scaledLevels, type CaseSetup } from "./setup";
import { NU } from "./types";

export const HISTORY_SLOTS = 4096;

export interface GpuInfo {
  device: GPUDevice;
  adapterName: string;
  /** Software rasteriser (e.g. SwiftShader): works, but 20–50× slower than a real GPU. */
  software: boolean;
}

export async function requestDevice(): Promise<GpuInfo> {
  if (!("gpu" in navigator) || !navigator.gpu) throw new Error("WebGPU is not available in this browser.");
  let adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const isSoftware = (a: GPUAdapter | null) =>
    !!a && (/swiftshader|llvmpipe|software/i.test(`${a.info?.vendor} ${a.info?.architecture} ${a.info?.description}`) ||
      (a as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter === true || a.info?.isFallbackAdapter === true);
  if (!adapter || isSoftware(adapter)) adapter = (await navigator.gpu.requestAdapter()) ?? adapter;
  if (!adapter) throw new Error("No WebGPU adapter was found.");
  const lim = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxBufferSize: lim.maxBufferSize,
      maxStorageBuffersPerShaderStage: Math.min(10, lim.maxStorageBuffersPerShaderStage),
      maxComputeWorkgroupStorageSize: lim.maxComputeWorkgroupStorageSize,
    },
  });
  const info = adapter.info;
  return { device, adapterName: [...new Set([info?.vendor, info?.architecture, info?.description].filter(Boolean))].join(" "), software: isSoftware(adapter) };
}

type Binding = "uniform" | "read" | "rw";

interface Kernel {
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
}

export interface FlowFields {
  vel: Float32Array;
  pres: Float32Array;
  turb: Float32Array;
  wallForces?: Float32Array;
  step?: number;
}

export class FlowSolver {
  readonly device: GPUDevice;
  readonly c: CaseSetup;
  private buffers: Record<string, GPUBuffer> = {};
  private levelBuffers: { phi: GPUBuffer; rhs: GPUBuffer; coef: GPUBuffer; uniform: GPUBuffer }[] = [];
  private kernels: Record<string, Kernel> = {};
  private groups: Record<string, GPUBindGroup> = {};
  private stepParity = 0;
  vcycles = 1;
  preSmooth = 2;
  postSmooth = 2;
  coarseSweeps = 12;
  dtInterval = 5;
  private stepsDone = 0;
  correctionFactor = 1.0;
  /** Local time stepping: per-cell step factors set by setTimeFactors(); the global step is frozen. */
  lts = false;
  splitMomentum = true;
  momentumSweeps = 4;
  sstSweeps = 4;
  private momentumRelaxation: number;
  private forceGroups: number;

  constructor(device: GPUDevice, c: CaseSetup, opts: { cfl?: number; correctionFactor?: number; momentumRelaxation?: number } = {}) {
    this.device = device;
    this.c = c;
    this.momentumRelaxation = opts.momentumRelaxation ?? 0.7;
    if (!(this.momentumRelaxation > 0 && this.momentumRelaxation <= 1)) throw new Error("Momentum relaxation must be in (0, 1]");
    if (opts.correctionFactor) this.correctionFactor = opts.correctionFactor;
    this.forceGroups = Math.max(1, Math.ceil(c.faceCount / WG));
    this.createBuffers(opts.cfl ?? 0.4);
    this.createKernels();
    this.createGroups();
  }

  private buffer(name: string, data: ArrayBufferView | number, usage = GPUBufferUsage.STORAGE) {
    const size = typeof data === "number" ? data : data.byteLength;
    if(size>Math.min(this.device.limits.maxBufferSize,this.device.limits.maxStorageBufferBindingSize)) throw new Error(`GPU buffer ${name} exceeds the device limit. Reduce the grid.`);
    const buf = this.device.createBuffer({
      size: Math.max(16, Math.ceil(size / 4) * 4),
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      label: name,
    });
    if (typeof data !== "number")
      this.device.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    this.buffers[name] = buf;
    return buf;
  }

  private createBuffers(cfl: number) {
    const c = this.c;
    const NC = c.NC;
    const params = new ArrayBuffer(128);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    u32.set([c.NX, c.NY, c.NZ, NC], 0);
    f32.set([c.inlet[0], c.inlet[1], c.inlet[2], c.groundSpeed], 4);
    f32.set([c.kIn, c.omegaIn, NU, 1], 8);
    f32.set([cfl, 1.0, 1.25, c.faceCount], 12);
    u32.set([c.sideMode, 1, c.partIsWheel.length, HISTORY_SLOTS], 16);
    u32.set(c.goff, 20);
    f32.set([...c.momentOrigin, 0], 24);
    u32.set([c.wallModel === "log" ? 1 : 0, 0, c.limiter, c.numericalFlags], 28);
    f32[29] = c.mergeBoost;
    this.buffer("params", new Uint8Array(params), GPUBufferUsage.UNIFORM);
    this.buffer("parts", c.parts, GPUBufferUsage.UNIFORM);
    this.buffer("grid", c.gridBuffer);
    this.buffer("flags", c.flags);
    this.buffer("aper", c.aper);
    this.buffer("wall", c.wall);
    this.buffer("faces", c.faces);
    this.buffer("partials", this.forceGroups * 24 * 4);
    this.buffer("faceForce", Math.max(1, c.faceCount) * 12 * 4);
    this.buffer("partRanges", c.partRanges.length ? c.partRanges : new Uint32Array(2));
    this.buffer("partAcc", Math.max(1, c.partRanges.length / 2) * 12 * 4);
    this.buffer("history", HISTORY_SLOTS * 32 * 4);
    this.buffer("lmax", 16);
    const hmin = c.grid.hmin ?? c.grid.h;
    // [dt, GPU time, step, pace factor of pseudo time (set with local time stepping)]
    this.buffer("state", new Float32Array([(0.1 * hmin) / c.freestream, 0, 0, 1]));

    // Initial field: free stream everywhere, zero on faces touching solid cells.
    const vel = new Float32Array(3 * NC);
    const { NX, NY } = c;
    const flags = c.flags;
    for (let idx = 0; idx < NC; idx++) {
      const sx = (flags[idx] & 1) | (idx + 1 < NC ? flags[idx + 1] & 1 : 0) | (c.aper[4 * idx] > 0 ? 0 : 1);
      const sy = (flags[idx] & 1) | (idx + NX < NC ? flags[idx + NX] & 1 : 0) | (c.aper[4 * idx + 1] > 0 ? 0 : 1);
      vel[idx] = sx ? 0 : c.inlet[0];
      vel[NC + idx] = sy ? 0 : c.inlet[1];
      void NY;
    }
    this.buffer("vel", vel);
    this.buffer("velStar", vel);
    this.buffer("mobility", new Float32Array(3 * NC));
    if (c.numericalFlags & (64|256)) this.buffer("pressureGeometry", c.levels[0].coef);
    if (c.numericalFlags & 64) {
      this.buffer("momentumMatrix", NC * 3 * 8 * 4);
      this.buffer("momentumA", vel);
      this.buffer("momentumB", vel);
    }
    this.buffer("divScratch", NC * 4);
    // Planes: k | omega | nut | wall distance (static) | local time-step factor (static between rebuilds).
    const turb = new Float32Array(5 * NC);
    turb.fill(c.kIn, 0, NC);
    turb.fill(c.omegaIn, NC, 2 * NC);
    turb.fill(c.kIn / c.omegaIn, 2 * NC, 3 * NC);
    turb.set(c.wallDist, 3 * NC);
    turb.fill(1, 4 * NC, 5 * NC);
    this.buffer("turbA", turb);
    this.buffer("turbB", turb);
    this.buffer("sstMatrix", c.numericalFlags & 2048 ? NC*5*16 : 16);
    if (c.numericalFlags & 2048) this.buffer("sstScratch", turb);

    c.levels.forEach((lvl, l) => {
      const coarse = c.levels[l + 1];
      const u = new Uint32Array(12);
      u.set([lvl.NX, lvl.NY, lvl.NZ, lvl.NC], 0);
      if (coarse) u.set([coarse.NX, coarse.NY, coarse.NZ, coarse.NC], 4);
      new Float32Array(u.buffer).set([this.correctionFactor, 0, 0, 0], 8);
      this.levelBuffers.push({
        phi: this.buffer(`phi${l}`, lvl.NC * 4),
        rhs: this.buffer(`rhs${l}`, lvl.NC * 4),
        coef: this.buffer(`coef${l}`, lvl.coef),
        uniform: this.buffer(`level${l}`, u, GPUBufferUsage.UNIFORM),
      });
    });
  }

  private kernel(name: string, code: string, bindings: Binding[], constants?: Record<string, number>) {
    const device = this.device;
    const module = device.createShaderModule({ code, label: name });
    const layout = device.createBindGroupLayout({
      label: name,
      entries: bindings.map((b, i) => ({
        binding: i,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: b === "uniform" ? "uniform" : b === "read" ? "read-only-storage" : "storage" },
      })),
    });
    const pipeline = device.createComputePipeline({
      label: name,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: "main", constants },
    });
    this.kernels[name] = { pipeline, layout };
  }

  private createKernels() {
    const base: Binding[] = ["uniform", "uniform", "read", "read"];
    this.kernel("momentum", momentumWGSL, [...base, "read", "rw", "read", "read", "read", "read"]);
    for (let a = 0; a < 3; a++) this.kernel(`momentum${a}`, momentumWGSL, [...base, "read", "rw", "read", "read", "read", "read"], { COMP: a });
    for (let p = 0; p < 3; p++) {
      this.kernel(`bcVel${p}`, bcVelocityWGSL, [...base, "rw"], { PHASE: p });
      this.kernel(`bcTurb${p}`, bcTurbWGSL, [...base, "rw", "read"], { PHASE: p });
    }
    this.kernel("divergence", divergenceWGSL, [...base, "read", "rw", "read", "read"]);
    this.kernel("correct", correctWGSL, [...base, "read", "rw", "read", "read", "read", "read", "read"]);
    if (this.c.numericalFlags & 64) {
      this.kernel("assembleMomentum", assembleMomentumWGSL, [...base, "read", "read", "read", "read", "rw", "rw", "read"], {RELAX: this.momentumRelaxation});
      this.kernel("solveMomentum", solveMomentumWGSL, [...base, "read", "rw", "read", "read", "read"]);
      this.kernel("extractMomentum", solveMomentumWGSL, [...base, "read", "rw", "read", "read", "read"], {EXTRACT: 1});
    }
    if (this.c.numericalFlags & (64|256)) {
      this.kernel("momentumPressure", momentumPressureWGSL, [...base, "read", "read", "rw", "read", "read", "read"]);
      this.kernel("coarsenMomentumPressure", coarsenMomentumPressureWGSL, ["uniform", "read", "rw"]);
    }
    this.kernel("turbulence", turbulenceWGSL, [...base, "read", "read", "rw", "read", "read", "read", "rw"], {IMPLICIT: (this.c.numericalFlags & 2048) ? 1 : 0});
    if (this.c.numericalFlags & 2048) {
      for (const component of [0,1]) this.kernel(`solveSst${component}`, solveSstWGSL, [...base,"read","rw","read"], {COMPONENT:component});
      this.kernel("finishSst", finishSstWGSL, [...base,"rw","read"]);
    }
    this.kernel("dtReduce", dtReduceWGSL, [...base, "read", "read", "rw", "read"]);
    this.kernel("dtFinalize", dtFinalizeWGSL, [...base, "rw", "rw"]);
    this.kernel("forces", forcesWGSL, [...base, "read", "read", "read", "read", "rw", "read", "rw"]);
    this.kernel("partForces", partForcesWGSL, [...base, "read", "read", "read", "rw"], { NPARTS: Math.max(1, this.c.partRanges.length / 2) });
    this.kernel("forcesSum", forcesSumWGSL, [...base, "read", "rw", "rw"], { GROUPS: this.forceGroups });
    this.kernel("smooth0", smoothWGSL, ["uniform", "read", "rw", "read"], { COLOR: 0 });
    this.kernel("smooth1", smoothWGSL, ["uniform", "read", "rw", "read"], { COLOR: 1 });
    this.kernel("restrict", restrictWGSL, ["uniform", "read", "read", "read", "rw", "rw"]);
    this.kernel("prolong", prolongWGSL, ["uniform", "read", "rw", "read"]);
  }

  private group(key: string, kernel: string, buffers: GPUBuffer[]) {
    this.groups[key] = this.device.createBindGroup({
      label: key,
      layout: this.kernels[kernel].layout,
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  private createGroups() {
    const b = this.buffers;
    const base = [b.params, b.parts, b.grid, b.flags];
    for (let p = 0; p < 3; p++) {
      this.group(`bcVel${p}:vel`, `bcVel${p}`, [...base, b.vel]);
      this.group(`bcVel${p}:velStar`, `bcVel${p}`, [...base, b.velStar]);
      this.group(`bcTurb${p}:A`, `bcTurb${p}`, [...base, b.turbA,b.vel]);
      this.group(`bcTurb${p}:B`, `bcTurb${p}`, [...base, b.turbB,b.vel]);
    }
    for (const [cur, next] of [
      ["A", "B"],
      ["B", "A"],
    ]) {
      const t = b[`turb${cur}`];
      const tn = b[`turb${next}`];
      this.group(`momentum:${cur}`, "momentum", [...base, b.vel, b.velStar, t, b.aper, b.state, b.wall]);
      this.group(`turbulence:${cur}`, "turbulence", [...base, b.vel, t, tn, b.state, b.aper, b.wall,b.sstMatrix]);
      if (this.c.numericalFlags & 2048) {
        for (const component of [0,1]) {
          this.group(`solveSst${component}:${next}:out`, `solveSst${component}`, [...base,tn,b.sstScratch,b.sstMatrix]);
          this.group(`solveSst${component}:${next}:back`, `solveSst${component}`, [...base,b.sstScratch,tn,b.sstMatrix]);
        }
        this.group(`finishSst:${next}`, "finishSst", [...base,tn,b.sstMatrix]);
      }
      this.group(`dtReduce:${cur}`, "dtReduce", [...base, b.vel, t, b.lmax, b.aper]);
      this.group(`forces:${cur}`, "forces", [...base, b.vel, t, this.levelBuffers[0].phi, b.faces, b.partials, b.wall, b.faceForce]);
      if (this.c.numericalFlags & 64) this.group(`assembleMomentum:${cur}`, "assembleMomentum", [...base, b.vel, t, b.aper, b.wall, b.momentumMatrix, b.mobility, b.state]);
    }
    const L = this.levelBuffers;
    this.group("divergence", "divergence", [...base, b.velStar, L[0].rhs, b.state, b.aper]);
    this.group("divergence:vel", "divergence", [...base, b.vel, b.divScratch, b.state, b.aper]);
    this.group("correct", "correct", [...base, b.velStar, b.vel, L[0].phi, b.turbA, b.state, b.aper, b.mobility]);
    if (this.c.numericalFlags & 64) {
      for (const [key, input, output] of [["start",b.vel,b.momentumA],["AB",b.momentumA,b.momentumB],["BA",b.momentumB,b.momentumA]] as const) {
        this.group(`solveMomentum:${key}`, "solveMomentum", [...base,input,output,b.momentumMatrix,b.mobility,L[0].phi]);
      }
      for (const parity of ["A","B"]) this.group(`extractMomentum:${parity}`, "extractMomentum", [...base,b[`momentum${parity}`],b.velStar,b.momentumMatrix,b.mobility,L[0].phi]);
    }
    for (const parity of ["A","B"]) if (this.c.numericalFlags & (64|256)) this.group(`momentumPressure:${parity}`, "momentumPressure", [...base,b.pressureGeometry,b.mobility,L[0].coef,b.state,b[`turb${parity}`],b.velStar]);
    this.group("dtFinalize", "dtFinalize", [...base, b.lmax, b.state]);
    this.group("forcesSum", "forcesSum", [...base, b.partials, b.state, b.history]);
    this.group("partForces", "partForces", [...base, b.faceForce, b.partRanges, b.state, b.partAcc]);
    L.forEach((lv, l) => {
      this.group(`smooth0:${l}`, "smooth0", [lv.uniform, lv.coef, lv.phi, lv.rhs]);
      this.group(`smooth1:${l}`, "smooth1", [lv.uniform, lv.coef, lv.phi, lv.rhs]);
      const c = L[l + 1];
      if (c) {
        this.group(`restrict:${l}`, "restrict", [lv.uniform, lv.coef, lv.phi, lv.rhs, c.rhs, c.phi]);
        this.group(`prolong:${l}`, "prolong", [lv.uniform, lv.coef, lv.phi, c.phi]);
        if (this.c.numericalFlags & (64|256)) this.group(`coarsenMomentumPressure:${l}`, "coarsenMomentumPressure", [lv.uniform,lv.coef,c.coef]);
      }
    });
  }

  private dispatch(pass: GPUComputePassEncoder, kernel: string, group: string, threads: number) {
    pass.setPipeline(this.kernels[kernel].pipeline);
    pass.setBindGroup(0, this.groups[group]);
    const groups = Math.max(1, Math.ceil(threads / WG));
    const gx = Math.min(groups, 65535);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
  }

  /** Dispatch `kernel` with a bind group created for `groupKernel` (identical layout). */
  private dispatchWith(pass: GPUComputePassEncoder, kernel: string, groupKernel: string, group: string, threads: number) {
    void groupKernel;
    pass.setPipeline(this.kernels[kernel].pipeline);
    pass.setBindGroup(0, this.groups[group]);
    const groups = Math.max(1, Math.ceil(threads / WG));
    const gx = Math.min(groups, 65535);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
  }

  private vcycle(pass: GPUComputePassEncoder) {
    const L = this.c.levels;
    const last = L.length - 1;
    for (let l = 0; l < last; l++) {
      for (let s = 0; s < this.preSmooth; s++) {
        this.dispatch(pass, "smooth0", `smooth0:${l}`, L[l].NC);
        this.dispatch(pass, "smooth1", `smooth1:${l}`, L[l].NC);
      }
      this.dispatch(pass, "restrict", `restrict:${l}`, L[l + 1].NC);
    }
    for (let s = 0; s < this.coarseSweeps; s++) {
      this.dispatch(pass, "smooth0", `smooth0:${last}`, L[last].NC);
      this.dispatch(pass, "smooth1", `smooth1:${last}`, L[last].NC);
    }
    for (let l = last - 1; l >= 0; l--) {
      this.dispatch(pass, "prolong", `prolong:${l}`, L[l].NC);
      for (let s = 0; s < this.postSmooth; s++) {
        this.dispatch(pass, "smooth1", `smooth1:${l}`, L[l].NC);
        this.dispatch(pass, "smooth0", `smooth0:${l}`, L[l].NC);
      }
    }
  }

  private encodeStep(pass: GPUComputePassEncoder) {
    const c = this.c;
    const NC = c.NC;
    const planes = [c.NY * c.NZ, c.NX * c.NZ, c.NX * c.NY];
    const cur = this.stepParity === 0 ? "A" : "B";
    for (let p = 0; p < 3; p++) this.dispatch(pass, `bcVel${p}`, `bcVel${p}:vel`, planes[p]);
    if (c.numericalFlags & 64) {
      this.dispatch(pass,"assembleMomentum",`assembleMomentum:${cur}`,NC);
      this.dispatch(pass,"solveMomentum","solveMomentum:start",NC);
      for (let s = 1; s < this.momentumSweeps; s++) this.dispatch(pass,"solveMomentum",`solveMomentum:${s % 2 ? "AB" : "BA"}`,NC);
      this.dispatch(pass,"extractMomentum",`extractMomentum:${this.momentumSweeps % 2 ? "A" : "B"}`,NC);
    } else if (this.splitMomentum) for (let a = 0; a < 3; a++) this.dispatchWith(pass, `momentum${a}`, "momentum", `momentum:${cur}`, NC);
    else this.dispatch(pass, "momentum", `momentum:${cur}`, NC);
    for (let p = 0; p < 3; p++) this.dispatch(pass, `bcVel${p}`, `bcVel${p}:velStar`, planes[p]);
    if (c.numericalFlags & (64|256)) {
      this.dispatch(pass,"momentumPressure",`momentumPressure:${cur}`,NC);
      for (let l = 0; l < c.levels.length-1; l++) this.dispatch(pass,"coarsenMomentumPressure",`coarsenMomentumPressure:${l}`,c.levels[l+1].NC);
    }
    this.dispatch(pass, "divergence", "divergence", NC);
    for (let v = 0; v < this.vcycles; v++) this.vcycle(pass);
    this.dispatch(pass, "correct", "correct", NC);
    for (let p = 0; p < 3; p++) this.dispatch(pass, `bcTurb${p}`, `bcTurb${p}:${cur}`, planes[p]);
    this.dispatch(pass, "turbulence", `turbulence:${cur}`, NC);
    this.stepParity ^= 1;
    const next = this.stepParity === 0 ? "A" : "B";
    if (c.numericalFlags & 2048) {
      for (const component of [1,0]) for (let s = 0; s < this.sstSweeps; s++) this.dispatch(pass,`solveSst${component}`,`solveSst${component}:${next}:${s % 2 ? "back" : "out"}`,NC);
      this.dispatch(pass,"finishSst",`finishSst:${next}`,NC);
    }
    this.dispatch(pass, "forces", `forces:${next}`, c.faceCount);
    this.dispatch(pass, "forcesSum", "forcesSum", WG);
    this.dispatch(pass, "partForces", "partForces", Math.max(1, this.c.partRanges.length / 2) * WG);
    if (!this.lts && this.stepsDone % this.dtInterval === 0) {
      this.dispatch(pass, "dtReduce", `dtReduce:${next}`, NC);
      this.dispatch(pass, "dtFinalize", "dtFinalize", 1);
    }
    this.stepsDone++;
  }

  /**
   * Make the initial field divergence-free without accumulating the impulsive start pressure.
   */
  initialProjection(vcycles = 12) {
    const c = this.c;
    const planes = [c.NY * c.NZ, c.NX * c.NZ, c.NX * c.NY];
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.buffers.vel, 0, this.buffers.velStar, 0, c.NC * 12);
    const pass = enc.beginComputePass();
    if (c.numericalFlags & 64) {
      this.dispatch(pass,"assembleMomentum","assembleMomentum:A",c.NC);
    }
    for (let p = 0; p < 3; p++) this.dispatch(pass, `bcVel${p}`, `bcVel${p}:velStar`, planes[p]);
    if (c.numericalFlags & (64|256)) {
      this.dispatch(pass,"momentumPressure","momentumPressure:A",c.NC);
      for (let l = 0; l < c.levels.length-1; l++) this.dispatch(pass,"coarsenMomentumPressure",`coarsenMomentumPressure:${l}`,c.levels[l+1].NC);
    }
    this.dispatch(pass, "divergence", "divergence", c.NC);
    for (let v = 0; v < vcycles; v++) this.vcycle(pass);
    this.dispatch(pass, "correct", "correct", c.NC);
    pass.end();
    enc.clearBuffer(this.levelBuffers[0].phi);
    this.device.queue.submit([enc.finish()]);
  }

  /** Divergence of the current velocity (volumetric imbalance / dt) into a scratch buffer and read it. */
  async measureDivergence(): Promise<Float32Array> {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    this.dispatch(pass, "divergence", "divergence:vel", this.c.NC);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return new Float32Array(await this.read(this.buffers.divScratch, this.c.NC * 4));
  }

  /** Debug: run `cycles` V-cycles on the level-0 system with the given right-hand side; returns φ after each. */
  async mgTest(rhs: Float32Array, cycles: number): Promise<Float32Array[]> {
    const L0 = this.levelBuffers[0];
    this.device.queue.writeBuffer(L0.rhs, 0, rhs);
    const enc0 = this.device.createCommandEncoder();
    enc0.clearBuffer(L0.phi);
    this.device.queue.submit([enc0.finish()]);
    const out: Float32Array[] = [];
    for (let c = 0; c < cycles; c++) {
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      this.vcycle(pass);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      out.push(new Float32Array(await this.read(L0.phi, this.c.NC * 4)));
    }
    return out;
  }

  /** Debug: average GPU time of each kernel type (ms), dispatching it `reps` times. */
  async kernelTimes(reps = 20): Promise<Record<string, number>> {
    const c = this.c;
    const NC = c.NC;
    const planes = [c.NY * c.NZ, c.NX * c.NZ, c.NX * c.NY];
    const tests: [string, (p: GPUComputePassEncoder) => void][] = [
      ["bcVel", (p) => { for (let q = 0; q < 3; q++) this.dispatch(p, `bcVel${q}`, `bcVel${q}:vel`, planes[q]); }],
      ["momentum", (p) => this.dispatch(p, "momentum", "momentum:A", NC)],
      ["divergence", (p) => this.dispatch(p, "divergence", "divergence", NC)],
      ["vcycle", (p) => this.vcycle(p)],
      ["smooth0", (p) => this.dispatch(p, "smooth0", "smooth0:0", NC)],
      ["correct", (p) => this.dispatch(p, "correct", "correct", NC)],
      ["turbulence", (p) => this.dispatch(p, "turbulence", "turbulence:A", NC)],
      ["forces", (p) => { this.dispatch(p, "forces", "forces:A", c.faceCount); this.dispatch(p, "forcesSum", "forcesSum", WG); }],
      ["dt", (p) => { this.dispatch(p, "dtReduce", "dtReduce:A", NC); this.dispatch(p, "dtFinalize", "dtFinalize", 1); }],
    ];
    const out: Record<string, number> = {};
    for (const [name, fn] of tests) {
      await this.device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      for (let r = 0; r < reps; r++) fn(pass);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      out[name] = (performance.now() - t0) / reps;
    }
    return out;
  }

  /**
   * Switch to (or update) local time stepping: `fac` is the per-cell step relative to `dtRef`
   * (ghosted array, ≥ 1). Rebuilds the pressure hierarchy with the scaled face conductances.
   */
  setTimeFactors(fac: Float32Array, dtRef: number) {
    const NC = this.c.NC;
    this.lts = true;
    this.device.queue.writeBuffer(this.buffers.turbA, 4 * NC * 4, fac);
    this.device.queue.writeBuffer(this.buffers.turbB, 4 * NC * 4, fac);
    this.device.queue.writeBuffer(this.buffers.state, 0, new Float32Array([dtRef]));
    const levels = scaledLevels(this.c, fac);
    levels.forEach((lv, l) => this.device.queue.writeBuffer(this.levelBuffers[l].coef, 0, lv.coef));
  }

  /** Pace of pseudo time relative to the GPU clock (local time stepping), used to weight part forces. */
  setPace(f: number) {
    this.device.queue.writeBuffer(this.buffers.state, 12, new Float32Array([f]));
  }

  /** Running pseudo-time integrals of the force on each part: pressure (3), shear (3) per part, per unit density. */
  async readPartForces(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.buffers.partAcc, Math.max(1, this.c.partRanges.length / 2) * 48));
  }

  /** Benchmark diagnostics for the last assembled SST systems; no extra flow step. */
  async readSstMatrix(): Promise<Float32Array | undefined> {
    if (!(this.c.numericalFlags & 2048)) return undefined;
    return new Float32Array(await this.read(this.buffers.sstMatrix,this.c.NC*80));
  }

  /** Encode and submit `n` steps. */
  run(n: number) {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (let i = 0; i < n; i++) this.encodeStep(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  get steps() {
    return this.stepsDone;
  }

  private async read(buf: GPUBuffer, bytes: number, offset = 0): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, offset, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return out;
  }

  /** Force history records: [time, dt, step, 0, body p(3), body v(3), wheel p(3), wheel v(3)] per slot. */
  async readHistory(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.buffers.history, HISTORY_SLOTS * 128));
  }

  async readWallForces(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.buffers.faceForce, Math.max(1, this.c.faceCount) * 48));
  }

  async readState(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.buffers.state, 16));
  }

  async readFields(includeWall = false): Promise<FlowFields> {
    const NC = this.c.NC;
    const turbName = this.stepParity === 0 ? "turbA" : "turbB";
    const [vel, pres, turb] = await Promise.all([
      this.read(this.buffers.vel, NC * 12),
      this.read(this.levelBuffers[0].phi, NC * 4),
      this.read(this.buffers[turbName], NC * 20),
    ]);
    return { vel: new Float32Array(vel), pres: new Float32Array(pres), turb: new Float32Array(turb), ...(includeWall ? { wallForces: await this.readWallForces(), step: this.steps } : {}) };
  }

  async readDivergence(): Promise<Float32Array> {
    return this.measureDivergence();
  }

  destroy() {
    for (const b of Object.values(this.buffers)) b.destroy();
  }
}
