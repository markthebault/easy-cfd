/// <reference types="@webgpu/types" />
/** Fused WebGPU adaptation of the same AeroJAX D2Q9 equations as lbm.ts.
 * Copyright (c) 2026 Arno Meijer and EasyCFD contributors.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */
import { CX, WEIGHTS, INLET } from "./lattice";

export class GpuLBM {
  steps = 0;
  private buffers: GPUBuffer[] = [];
  private index = 0;
  private pendingRead = false;
  private forceBuffer!: GPUBuffer;
  private forceOutput!: GPUBuffer;
  private forceReadback!: GPUBuffer;
  private forcePipeline!: GPUComputePipeline;
  private forceBindings!: GPUBindGroup;
  private forceSteps = 0;
  private constructor(private device: GPUDevice, readonly nx: number, readonly ny: number, private pipeline: GPUComputePipeline, private bindings: GPUBindGroup[], private output: GPUBuffer, private readback: GPUBuffer) {}

  static async create(nx: number, ny: number, mask: Float32Array, tau: number, smagorinsky = 0) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const buffers: GPUBuffer[] = [];
    try {
      const n = nx * ny;
      const buffer = (size: number, usage: GPUBufferUsageFlags, data?: Float32Array) => { const b = device.createBuffer({ size, usage }); buffers.push(b); if (data) device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>); return b; };
      const populations = new Float32Array(9 * n);
      for (let i = 0; i < 9; i++) { const cu = CX[i] * INLET; populations.fill(WEIGHTS[i] * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * INLET * INLET), i * n, (i + 1) * n); }
      const a = buffer(populations.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, populations);
      const b = buffer(populations.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, populations);
      const solid = buffer(mask.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mask);
      const output = buffer(3 * n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const readback = buffer(3 * n * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const forceBuffer = buffer(2 * n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const groups = Math.ceil(n / 256);
      const forceOutput = buffer(groups * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const forceReadback = buffer(groups * 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const code = `
const NX:u32=${nx}u; const NY:u32=${ny}u; const N:u32=NX*NY;
const U:f32=${INLET}; const OMEGA:f32=${1 / tau}; const TAU:f32=${tau}; const CS:f32=${smagorinsky};
const CX:array<i32,9>=array<i32,9>(0,1,0,-1,0,1,-1,-1,1);
const CY:array<i32,9>=array<i32,9>(0,0,1,0,-1,1,1,-1,-1);
const OPP:array<u32,9>=array<u32,9>(0u,3u,4u,1u,2u,7u,8u,5u,6u);
const W:array<f32,9>=array<f32,9>(4./9.,1./9.,1./9.,1./9.,1./9.,1./36.,1./36.,1./36.,1./36.);
@group(0) @binding(0) var<storage,read> f:array<f32>;
@group(0) @binding(1) var<storage,read_write> next:array<f32>;
@group(0) @binding(2) var<storage,read> solid:array<f32>;
@group(0) @binding(3) var<storage,read_write> field:array<f32>;
@group(0) @binding(4) var<storage,read_write> forceSum:array<vec2<f32>>;
@compute @workgroup_size(16,8) fn main(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=NX || id.y>=NY){return;}
  let cell=id.y*NX+id.x;
  if(id.x==0u || id.y==0u || id.y==NY-1u || solid[cell]>.5){
    for(var i=0u;i<9u;i++){let cu=f32(CX[i])*U;next[i*N+cell]=W[i]*(1.+3.*cu+4.5*cu*cu-1.5*U*U);}
    field[cell]=select(1.,0.,solid[cell]>.5);field[N+cell]=0.;field[2u*N+cell]=0.;return;
  }
  var streamed:array<f32,9>;var rho=0.;var ux=0.;var uy=0.;var force=vec2<f32>(0.);
  for(var i=0u;i<9u;i++){
    let sx=u32(clamp(i32(id.x)-CX[i],0,i32(NX)-2));let sy=u32(clamp(i32(id.y)-CY[i],0,i32(NY)-1));let source=sy*NX+sx;
    var value=f[i*N+source];if(solid[source]>.5){value=f[OPP[i]*N+cell];force-=2.*value*vec2<f32>(f32(CX[i]),f32(CY[i]));}
    streamed[i]=value;rho+=value;ux+=f32(CX[i])*value;uy+=f32(CY[i])*value;
  }
  forceSum[cell]+=force;
  ux/=rho;uy/=rho;let speed2=ux*ux+uy*uy;
  var eq:array<f32,9>;var qxx=0.;var qyy=0.;var qxy=0.;
  for(var i=0u;i<9u;i++){let cx=f32(CX[i]);let cy=f32(CY[i]);let cu=cx*ux+cy*uy;eq[i]=W[i]*rho*(1.+3.*cu+4.5*cu*cu-1.5*speed2);let neq=streamed[i]-eq[i];qxx+=cx*cx*neq;qyy+=cy*cy*neq;qxy+=cx*cy*neq;}
  var omega=OMEGA;if(CS>0.){let norm=sqrt(qxx*qxx+qyy*qyy+2.*qxy*qxy);let tauEff=.5*(TAU+sqrt(TAU*TAU+18.*sqrt(2.)*CS*CS*norm/rho));omega=1./tauEff;}
  for(var i=0u;i<9u;i++){next[i*N+cell]=streamed[i]+omega*(eq[i]-streamed[i]);}
  field[cell]=ux/U;field[N+cell]=uy/U;field[2u*N+cell]=(rho-1.)*2./(3.*U*U);
}`;
      device.pushErrorScope("validation");
      const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
      const validation = await device.popErrorScope(); if (validation) throw new Error(validation.message);
      const bindings = [[a, b], [b, a]].map(([input, outputBuffer]) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [input, outputBuffer, solid, output, forceBuffer].map((b, binding) => ({ binding, resource: { buffer: b } })) }));
      const reductionCode = `
@group(0) @binding(0) var<storage,read> input:array<vec2<f32>>;
@group(0) @binding(1) var<storage,read_write> output:array<vec2<f32>>;
var<workgroup> partial:array<vec2<f32>,256>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3<u32>,@builtin(local_invocation_index) local:u32,@builtin(workgroup_id) group:vec3<u32>){
  var value=vec2<f32>(0.);if(id.x<${n}u){value=input[id.x];}partial[local]=value;workgroupBarrier();
  for(var stride=128u;stride>0u;stride/=2u){if(local<stride){partial[local]+=partial[local+stride];}workgroupBarrier();}
  if(local==0u){output[group.x]=partial[0];}
}`;
      const forcePipeline = await device.createComputePipelineAsync({layout:"auto",compute:{module:device.createShaderModule({code:reductionCode}),entryPoint:"main"}});
      const forceBindings = device.createBindGroup({layout:forcePipeline.getBindGroupLayout(0),entries:[forceBuffer,forceOutput].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const solver = new GpuLBM(device, nx, ny, pipeline, bindings, output, readback);
      Object.assign(solver,{buffers,forceBuffer,forceOutput,forceReadback,forcePipeline,forceBindings});return solver;
    } catch (error) { buffers.forEach(b => b.destroy()); device.destroy(); throw error; }
  }
  advance(count: number) {
    const encoder = this.device.createCommandEncoder(); encoder.clearBuffer(this.forceBuffer); this.forceSteps=count; const pass = encoder.beginComputePass(); pass.setPipeline(this.pipeline);
    for (let i = 0; i < count; i++) { pass.setBindGroup(0, this.bindings[this.index]); pass.dispatchWorkgroups(Math.ceil(this.nx / 16), Math.ceil(this.ny / 8)); this.index = 1 - this.index; }
    pass.end(); this.device.queue.submit([encoder.finish()]); this.steps += count;
  }
  async field() {
    if (this.pendingRead) throw new Error("A flow readback is already in progress."); this.pendingRead = true;
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, this.readback.size); this.device.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ); const result = new Float32Array(this.readback.getMappedRange()).slice(); this.readback.unmap(); return result;
    } finally { this.pendingRead = false; }
  }
  async forces() {
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.forcePipeline);pass.setBindGroup(0,this.forceBindings);pass.dispatchWorkgroups(Math.ceil(this.nx*this.ny/256));pass.end();
    encoder.copyBufferToBuffer(this.forceOutput,0,this.forceReadback,0,this.forceReadback.size);this.device.queue.submit([encoder.finish()]);
    await this.forceReadback.mapAsync(GPUMapMode.READ);const values=new Float32Array(this.forceReadback.getMappedRange());let x=0,y=0;for(let i=0;i<values.length;i+=2){x+=values[i];y+=values[i+1];}this.forceReadback.unmap();return {x,y,steps:this.forceSteps};
  }
  dispose() { this.buffers.forEach(b => b.destroy()); this.device.destroy(); }
}
