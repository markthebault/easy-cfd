import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("real WGSL wall stress agrees with laminar Couette traction and moving-wall slip", async ({
  page,
}) => {
  await page.goto("/bench.html");
  const data = await page.evaluate(async () => {
    const { common } = await import("/src/solver/kernels/common.ts" as string);
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const code =
      common +
      `
      @group(0) @binding(4) var<storage,read_write> result: array<vec4<f32>>;
      @compute @workgroup_size(1) fn main() {
        let fixed = P.turb.w * wallShear(vec3<f32>(2.0,0.0,0.0),0.001,0.0);
        let moving = wallVelocity(0u,vec3<f32>(0.0,0.0,0.5));
        result[0]=vec4<f32>(fixed,length(fixed));
        result[1]=vec4<f32>(P.turb.w*wallShear(vec3<f32>(2.0,0.0,0.0)-moving,0.001,0.0),0.0);
        result[2]=vec4<f32>(P.turb.w*wallShear(vec3<f32>(1.0,0.0,0.0)-moving,0.001,0.0),0.0);
        result[3]=vec4<f32>(P.turb.w*wallShear(vec3<f32>(0.0),0.001,0.0),0.0);
      }`;
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code }),
        entryPoint: "main",
      },
    });
    const uniform = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const parts = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const out = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const read = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const params = new ArrayBuffer(128),
      f = new Float32Array(params),
      u = new Uint32Array(params);
    f[10] = 1.5e-5;
    u[17] = 1;
    const wheels = new Float32Array(256);
    wheels[3] = 4;
    device.queue.writeBuffer(parts, 0, wheels);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: parts } },
        { binding: 4, resource: { buffer: out } },
      ],
    });
    const values = [];
    for (const density of [1, 1.225]) {
      f[11] = density;
      device.queue.writeBuffer(uniform, 0, params);
      const enc = device.createCommandEncoder(),
        pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      enc.copyBufferToBuffer(out, 0, read, 0, 64);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      values.push({
        density,
        stress: Array.from(new Float32Array(read.getMappedRange())),
      });
      read.unmap();
    }
    for (const b of [uniform, parts, out, read]) b.destroy();
    device.destroy();
    return {
      reference:
        "Laminar Couette tau = density * nu * (fluid - wall velocity) / y",
      nu: 1.5e-5,
      gap: 0.001,
      values,
    };
  });
  for (const v of data.values) {
    expect(v.stress[0]).toBeCloseTo(v.density * 0.03, 7);
    expect(v.stress[3]).toBeCloseTo(v.stress[0], 7);
    expect(v.stress.slice(4, 8)).toEqual([0, 0, 0, 0]);
    expect(v.stress[8]).toBeCloseTo(-v.density * 0.015, 7);
    expect(v.stress.slice(12)).toEqual([0, 0, 0, 0]);
  }
  await writeFile(
    "test-results/aero-couette-verification.json",
    JSON.stringify(data, null, 2),
  );
});
