import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import createModule from '../web/public/vvflow/vvflow.mjs';

const server = await createServer({
  root: resolve(import.meta.dirname, '../web'),
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
let data;
try {
  const { MX5_NC_PRHT } = await server.ssrLoadModule('/src/flow2d/presets/mx5NcPrht.ts');
  const { vortexOutlines } = await server.ssrLoadModule('/src/flow2d/vortexGeometry.ts');
  data = vortexOutlines([MX5_NC_PRHT.points], 4);
} finally {
  await server.close();
}
const module = await createModule();
const pointer = module._malloc(data.length * 8);
module.HEAPF64.set(data, pointer / 8);
const start = ground => {
  assert.equal(module._vv_scene(pointer, data.length, 320, 40000, .005, ground), 0,
    module.UTF8ToString(module._vv_error()));
  assert.equal(module._vv_density(2), 0);
};
const report = [];
try {
  start(1);
  assert.equal(module._vv_body_count(), 320, 'Image bodies must stay out of exported geometry');
  const initialBodies = Array.from(module.HEAPF64.subarray(module._vv_bodies() / 8, module._vv_bodies() / 8 + module._vv_body_count() * 3));
  for (let step = 1; step <= 500; step++) {
    assert.equal(module._vv_step(1), 0, module.UTF8ToString(module._vv_error()));
    if (![50, 200, 500].includes(step)) continue;
    const at = module._vv_particles() / 8;
    const particles = module.HEAPF64.subarray(at, at + module._vv_count() * 4);
    const stats = Array.from(module.HEAPF64.subarray(module._vv_stats() / 8, module._vv_stats() / 8 + 10));
    assert.ok(stats.every(Number.isFinite));
    assert.equal(stats[5], step);
    assert.deepEqual(Array.from(module.HEAPF64.subarray(module._vv_bodies() / 8, module._vv_bodies() / 8 + module._vv_body_count() * 3)), initialBodies, 'Stationary boundaries must retain their exact coordinates');
    let minY = Infinity, maxX = -Infinity, upperCount = 0, underbodyMinY = Infinity;
    for (let i = 0; i < particles.length; i += 4) {
      const [x, y, circulation, core] = particles.subarray(i, i + 4);
      assert.ok([x, y, circulation, core].every(Number.isFinite));
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      if (y > .1 && x < 1.65) upperCount++;
      if (x > .85 && x < 1.65 && y < .04) underbodyMinY = Math.min(underbodyMinY, y);
    }
    assert.ok(minY > 0, 'Export only physical half-plane vortices');
    assert.ok(upperCount > 100, 'Upper-surface shedding must survive advection');
    // The former ground produced columns spanning almost the whole 0.0375 gap.
    // This case should retain a surface layer above 0.02 at all three times.
    assert.ok(underbodyMinY > .02 && underbodyMinY < .04, 'Underbody layer must not form a floor-spanning comb');
    if (step === 500) assert.ok(maxX > 2.8, 'The wake must advect downstream');
    report.push({ step, time: stats[0], count: module._vv_count(), minY, underbodyMinY, upperCount, maxX, cd: stats[1], cl: stats[2] });
    console.log('ground', JSON.stringify(report.at(-1)));
  }
  // Ground state must clear when a caller starts an unbounded scene.
  start(0);
  assert.equal(module._vv_body_count(), 320);
  assert.equal(module._vv_count(), 0);
  assert.equal(module._vv_step(1), 0);
  assert.ok(module._vv_count() > 0);
  const touching = data.slice();
  for (let i = 2; i < touching.length; i += 2) touching[i] -= .0375;
  module.HEAPF64.set(touching, pointer / 8);
  assert.equal(module._vv_scene(pointer, touching.length, 320, 40000, .005, 1), -1);
  assert.match(module.UTF8ToString(module._vv_error()), /above the ground/);
  writeFileSync(resolve(import.meta.dirname, 'image-ground-validation.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
  module._free(pointer);
  module._vv_dispose();
}
