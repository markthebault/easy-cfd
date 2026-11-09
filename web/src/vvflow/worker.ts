/// <reference lib="webworker" />
import type { Case, VVModule, Message } from './types';
let module: VVModule, running = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
const send = (message: Message, transfer: Transferable[] = []) => postMessage(message, transfer);
function fail(error: unknown) { running = false; send({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
function frame(elapsed = 0) {
  const particles = new Float32Array(module.HEAPF64.subarray(module._vv_particles() / 8, module._vv_particles() / 8 + module._vv_count() * 4));
  const bodies = new Float32Array(module.HEAPF64.subarray(module._vv_bodies() / 8, module._vv_bodies() / 8 + module._vv_body_count() * 3));
  const stats = Array.from(module.HEAPF64.subarray(module._vv_stats() / 8, module._vv_stats() / 8 + 10));
  send({ type: 'frame', particles, bodies, stats, elapsed, running }, [particles.buffer, bodies.buffer]);
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
self.onmessage = async (event: MessageEvent<{ type: string; config?: Case }>) => {
  try {
    const { type, config } = event.data;
    if (type === 'init' && config) {
      const token = ++generation;
      const url = new URL('/vvflow/vvflow.mjs', self.location.origin).href;
      const { default: create } = await import(/* @vite-ignore */ url);
      const loaded: VVModule = await create({ locateFile: (name: string) => new URL(`/vvflow/${name}`, self.location.origin).href });
      if (token !== generation) { loaded._vv_dispose(); return; }
      module = loaded;
      if (module._vv_init(config.shape, config.panels, config.re, config.dt, config.angle)) throw new Error(module.UTF8ToString(module._vv_error()));
      running = false; send({ type: 'ready' }); frame();
    } else if (type === 'run') { if (!running) { running = true; advance(); } }
    else if (type === 'pause') { running = false; if (timer) clearTimeout(timer); timer = undefined; frame(); }
    else if (type === 'step' && !running) { if (module._vv_step(1)) throw new Error(module.UTF8ToString(module._vv_error())); frame(); }
  } catch (error) { fail(error); }
};
