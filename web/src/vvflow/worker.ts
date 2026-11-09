/// <reference lib="webworker" />
import type { Case, VVModule, Message } from './types';
let pressureView: number[] | null = null, lastPressure = -Infinity;
let module: VVModule, running = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
const send = (message: Message, transfer: Transferable[] = []) => postMessage(message, transfer);
function fail(error: unknown) { running = false; send({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
function samplePressure() {
  if (!module || !pressureView) return;
  const [xmin, ymin, width, height] = pressureView;
  // Square samples; keep tall/mobile views within the sampling budget too.
  const nx = Math.max(16, Math.min(144, Math.floor(112 * width / height))), spacing = width / (nx - 1);
  const ny = Math.max(2, Math.min(128, Math.ceil(height / spacing) + 1));
  const start = performance.now();lastPressure = start;
  if (module._vv_pressure(xmin, ymin, spacing, nx, ny)) { send({ type: 'pressure-error', error: module.UTF8ToString(module._vv_error()) });return; }
  const ptr = module._vv_pressure_data() / 8;
  const values = new Float32Array(module.HEAPF64.subarray(ptr, ptr + nx * ny));
  send({ type: 'pressure', field: { values, xmin, ymin, spacing, nx, ny, time: module.HEAPF64[module._vv_stats() / 8], elapsed: performance.now() - start } }, [values.buffer]);
}
function frame(elapsed = 0) {
  const particles = new Float32Array(module.HEAPF64.subarray(module._vv_particles() / 8, module._vv_particles() / 8 + module._vv_count() * 4));
  const bodies = new Float32Array(module.HEAPF64.subarray(module._vv_bodies() / 8, module._vv_bodies() / 8 + module._vv_body_count() * 3));
  const stats = Array.from(module.HEAPF64.subarray(module._vv_stats() / 8, module._vv_stats() / 8 + 10));
  send({ type: 'frame', particles, bodies, stats, elapsed, running }, [particles.buffer, bodies.buffer]);
  if (pressureView && performance.now() - lastPressure >= 500) samplePressure();
}
function advance() {
  timer = undefined;
  if (!running) return;
  try {
    const start = performance.now();
    // One step is the minimum interruptible unit. Bound each batch in wall time.
    do { if (module._vv_step(1)) throw new Error(module.UTF8ToString(module._vv_error())); }
    while (performance.now() - start < 24 && module.HEAPF64[module._vv_stats() / 8] < 40);
    if (module.HEAPF64[module._vv_stats() / 8] >= 40) running = false;
    frame(performance.now() - start);
    if (running) timer = setTimeout(advance, 0);
  } catch (error) { fail(error); }
}
self.onmessage = async (event: MessageEvent<{ type: string; config?: Case; view?: number[] | null }>) => {
  try {
    const { type, config } = event.data;
    if (type === 'pressure-view') {
      pressureView = event.data.view || null; lastPressure = -Infinity;
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
    else if (type === 'pause') { running = false; if (timer) clearTimeout(timer); timer = undefined; lastPressure = -Infinity; frame(); }
    else if (type === 'step' && !running) { if (module._vv_step(1)) throw new Error(module.UTF8ToString(module._vv_error())); frame(); }
  } catch (error) { fail(error); }
};
