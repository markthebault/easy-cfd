import { BrowserLBM } from "./lbm";
import { type Point } from "./geometry";
import { TUNNELS, liveTau, type TunnelId } from "./grid";
import { sceneMask } from "./scene";
import { GpuLBM } from "./gpu";
import { ForceMonitor, type ForceReport } from "./metrics";

export type FlowRequest = { type: "start"; outlines: Point[][]; referenceLength: number; signature: string; tunnel: TunnelId; version: number; forceWasm?: boolean } | { type: "tick"; count: number; version: number };
export type FlowReply = { type: "vortices"; particles: Float32Array; steps: number; version: number; backend: string; elapsed: number } | { type: "field"; values: Float32Array; metrics: ForceReport; steps: number; version: number; backend: string; elapsed: number } | { type: "error"; message: string; version: number };
let solver: BrowserLBM | GpuLBM | undefined, backend = "", version = 0;
let monitor: ForceMonitor;
// Serialize initialization and stepping. Geometry may change while a readback is pending.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<FlowRequest>) => {
  queue = queue.then(async () => {
    const request = event.data;
    try {
      if (request.type === "start") {
        solver?.dispose(); solver = undefined; version = request.version;
        const grid = TUNNELS[request.tunnel], {nx: NX, ny: NY} = grid, tau = liveTau(grid);
        const mask = sceneMask(request.outlines, NX, NY, grid);
        if (!request.forceWasm) {
          try { solver = await GpuLBM.create(NX, NY, mask, tau, .1) ?? undefined; } catch { /* The portable solver remains available. */ }
        }
        backend = solver ? "webgpu" : await BrowserLBM.backend(true);
        if (import.meta.env.DEV) console.debug("2D backend ready", backend);
        solver ??= new BrowserLBM(NX, NY, mask, tau, .1);
        monitor = new ForceMonitor(grid, request.referenceLength, backend, request.outlines.length > 0, request.signature);
      }
      if (!solver || request.version !== version) return;
      const start = performance.now();
      solver.advance(monitor.batchSize(request.type === "start" ? 8 : request.count, solver.steps));
      const [values, forces] = await Promise.all([solver.field(), solver.forces()]);
      if (import.meta.env.DEV && solver.steps === 8) console.debug("2D first field", performance.now() - start);
      if (values.some(v => !Number.isFinite(v) || Math.abs(v) > 1000)) throw new Error("Flow became unstable. Reset the flow or try a wider gap.");
      const metrics = monitor.push(forces, solver.steps);
      const reply: FlowReply = { type: "field", values, metrics, steps: solver.steps, version, backend, elapsed: performance.now() - start };
      self.postMessage(reply, { transfer: [values.buffer] });
    } catch (error) {
      self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Could not start browser flow.", version: request.version } satisfies FlowReply);
    }
  });
};
