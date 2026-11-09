/// <reference lib="webworker" />
import type { Case, VVModule, Message } from './types';
let pressureView: number[] | null = null, lastPressure = -Infinity, pressureWidth = 144, estimatedStepMs = 5, lastPressureStep = -1;
let module: VVModule, running = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
const send = (message: Message, transfer: Transferable[] = []) => postMessage(message, transfer);
function fail(error: unknown) { running = false; send({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
function samplePressure() {
  if (!module || !pressureView) return;
  const step = module.HEAPF64[module._vv_stats() / 8 + 5];
  if (step === lastPressureStep) return;
  const [xmin, ymin, width, height] = pressureView;
  // Square samples; keep tall/mobile views within the sampling budget too.
  const nx = Math.max(16, Math.min(Math.round(running ? pressureWidth : 144), Math.floor(112 * width / height))), spacing = width / (nx - 1);
  const ny = Math.max(2, Math.min(128, Math.ceil(height / spacing) + 1));
  const start = performance.now();lastPressure = start;
  if (module._vv_pressure(xmin, ymin, spacing, nx, ny)) { send({ type: 'pressure-error', error: module.UTF8ToString(module._vv_error()) });return; }
  lastPressureStep = step;
  const ptr = module._vv_pressure_data() / 8;
  const values = new Float32Array(module.HEAPF64.subarray(ptr, ptr + nx * ny));
  const elapsed = performance.now() - start;
  // Leave CPU time for a solver step within the 100 ms refresh budget.
  // Adapt only the display grid; vortex simulation resolution is unchanged.
  const budget = Math.max(20, Math.min(55, 90 - estimatedStepMs));
  if (elapsed > budget * 1.1 || elapsed < budget * .75) pressureWidth = Math.max(56, Math.min(144, pressureWidth * Math.max(.7, Math.min(1.05, Math.sqrt(budget / Math.max(1, elapsed))))));
  send({ type: 'pressure', field: { values, xmin, ymin, spacing, nx, ny, time: module.HEAPF64[module._vv_stats() / 8], elapsed } }, [values.buffer]);
}
function frame(elapsed = 0) {
  const particles = new Float32Array(module.HEAPF64.subarray(module._vv_particles() / 8, module._vv_particles() / 8 + module._vv_count() * 4));
  const bodies = new Float32Array(module.HEAPF64.subarray(module._vv_bodies() / 8, module._vv_bodies() / 8 + module._vv_body_count() * 3));
  const stats = Array.from(module.HEAPF64.subarray(module._vv_stats() / 8, module._vv_stats() / 8 + 10));
  send({ type: 'frame', particles, bodies, stats, elapsed, running }, [particles.buffer, bodies.buffer]);
  if (pressureView && performance.now() - lastPressure >= 100) samplePressure();
}
function advance() {
  timer = undefined;
  if (!running) return;
  try {
    if (pressureView) {
      const remaining = 100 - (performance.now() - lastPressure);
      if (remaining <= 0) samplePressure();
      else if (remaining < estimatedStepMs + 1 && lastPressureStep !== module.HEAPF64[module._vv_stats() / 8 + 5]) {
        // Don't start a step that is likely to overrun the next pressure frame.
        timer = setTimeout(advance, Math.max(1, remaining));return;
      }
    }
    const start = performance.now(), firstStep = module.HEAPF64[module._vv_stats() / 8 + 5];
    // One step is the minimum interruptible unit. Bound each batch in wall time.
    do { if (module._vv_step(1)) throw new Error(module.UTF8ToString(module._vv_error())); }
    while (performance.now() - start < 24 && (!pressureView || performance.now() + estimatedStepMs - lastPressure < 100) && module.HEAPF64[module._vv_stats() / 8] < 40);
    if (module.HEAPF64[module._vv_stats() / 8] >= 40) running = false;
    const elapsed = performance.now() - start;
    estimatedStepMs = elapsed / Math.max(1, module.HEAPF64[module._vv_stats() / 8 + 5] - firstStep);
    frame(elapsed);
    if (running) timer = setTimeout(advance, 0);
  } catch (error) { fail(error); }
}
self.onmessage = async (event: MessageEvent<{ type: string; config?: Case; view?: number[] | null }>) => {
  try {
    const { type, config } = event.data;
    if (type === 'pressure-view') {
      pressureView = event.data.view || null; lastPressure = -Infinity;lastPressureStep = -1;
      if (module && pressureView && !running) samplePressure();
    } else if (type === 'init' && config) {
      const token = ++generation;
      const url = new URL('/vvflow/vvflow.mjs', self.location.origin).href;
      const { default: create } = await import(/* @vite-ignore */ url);
      const loaded: VVModule = await create({ locateFile: (name: string) => new URL(`/vvflow/${name}`, self.location.origin).href });
      if (token !== generation) { loaded._vv_dispose(); return; }
      module = loaded;
      if (module._vv_init(config.shape, config.panels, config.re, config.dt, config.angle)) throw new Error(module.UTF8ToString(module._vv_error()));
      if (module._vv_density(config.density ?? 1)) throw new Error(module.UTF8ToString(module._vv_error()));
      running = false; send({ type: 'ready' }); frame();
    } else if (type === 'run') { if (!running) { running = true; advance(); } }
    else if (type === 'pause') { running = false; if (timer) clearTimeout(timer); timer = undefined; lastPressure = -Infinity;lastPressureStep = -1; frame(); }
    else if (type === 'step' && !running) { if (module._vv_step(1)) throw new Error(module.UTF8ToString(module._vv_error())); frame(); }
  } catch (error) { fail(error); }
};
