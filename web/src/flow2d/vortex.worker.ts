/// <reference lib="webworker" />
import type { FlowRequest, FlowReply } from './flow.worker';
import {ForceMonitor, type ForceReport} from './metrics';
import {TUNNELS} from './grid';
import { vortexOutlines } from './vortexGeometry';
interface Module {
  HEAPF64: Float64Array;
  _malloc(size: number): number; _free(pointer: number): void;
  _vv_scene(data: number, length: number, panels: number, re: number, dt: number, ground: number): number;
  _vv_density(density: number): number; _vv_dispose(): void;
  _vv_step(count: number): number; _vv_count(): number; _vv_particles(): number; _vv_stats(): number; _vv_error(): number;
  UTF8ToString(pointer: number): string;
}
let module: Module | undefined, version = 0, reference = 1, empty = false, steps = 0;
let monitor: ForceMonitor, metrics: ForceReport;
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<FlowRequest>) => {
  queue = queue.then(async () => {
    const request = event.data;
    try {
      const start = performance.now();
      if (request.type === 'start') {
        version = request.version;steps = 0;reference = request.referenceLength;
        monitor = new ForceMonitor(TUNNELS[request.tunnel], reference, 'vvflow', request.outlines.length > 0, request.signature, {stepDistance:.005*reference,factor:1,key:'vvflow-section-mean-1-Re40000-dt0.005-panels320-density2-slip-ground-1'});
        module?._vv_dispose();const outlines = vortexOutlines(request.outlines, reference);empty = !outlines.length;
        if (!empty) {
          if (!module) { const path = new URL('/vvflow/vvflow.mjs', self.location.origin).href;
            const { default: create } = await import(/* @vite-ignore */ path);
            module = await create({ locateFile: (file: string) => new URL(`/vvflow/${file}`, self.location.origin).href });
          }
          const ptr = module!._malloc(outlines.length * 8);
          if (!ptr) throw new Error('Not enough browser memory for the scene.');
          try { module!.HEAPF64.set(outlines, ptr / 8);if (module!._vv_scene(ptr, outlines.length, 320, 40000, .005, 1)) throw new Error(module!.UTF8ToString(module!._vv_error())); }
          finally { module!._free(ptr); }
          if (module!._vv_density(2)) throw new Error(module!.UTF8ToString(module!._vv_error()));
        }
      }
      if (request.version !== version) return;
      if (!empty && module) {
        const count = request.type === 'start' ? 1 : Math.max(1, Math.min(32, request.count)), tick = performance.now();
        for (let i = 0; i < count; i++) { if (module._vv_step(1)) throw new Error(module.UTF8ToString(module._vv_error()));const at=module._vv_stats()/8;steps=module.HEAPF64[at+5];metrics=monitor.push({x:module.HEAPF64[at+1],y:module.HEAPF64[at+2],steps:1},steps);metrics.instantaneousCd=module.HEAPF64[at+1];metrics.instantaneousCl=module.HEAPF64[at+2];if (performance.now() - tick > 25) break; }
        steps = module.HEAPF64[module._vv_stats() / 8 + 5];
      }
      if (empty) metrics = monitor.push({x:0,y:0,steps:1},++steps);
      const count = empty ? 0 : module!._vv_count(), ptr = empty ? 0 : module!._vv_particles() / 8;
      const particles = empty ? new Float32Array() : new Float32Array(module!.HEAPF64.subarray(ptr, ptr + count * 4));
      for (let i = 0; i < particles.length; i += 4) { particles[i] *= reference;particles[i + 1] *= reference;particles[i + 3] *= reference; }
      postMessage({ type: 'vortices', metrics, particles, steps, version, backend: 'vvflow', elapsed: performance.now() - start } satisfies FlowReply, [particles.buffer]);
    } catch (error) { postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not run vortex particles.', version: request.version } satisfies FlowReply); }
  });
};
