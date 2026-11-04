import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

let server, BrowserLBM, geometry, scene, FlowDye, vortices;
before(async () => {
  server = await createServer({ optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  ({ BrowserLBM } = await server.ssrLoadModule("/src/flow2d/lbm.ts"));
  geometry = await server.ssrLoadModule("/src/flow2d/geometry.ts");
  scene = await server.ssrLoadModule("/src/flow2d/scene.ts");
  ({ FlowDye } = await server.ssrLoadModule("/src/flow2d/dye.ts"));
  vortices = await server.ssrLoadModule("/src/flow2d/vortices.ts");
  await BrowserLBM.backend(true);
});

test("vortex outlines identify rotation without labelling pure shear as a core", () => {
  assert.equal(vortices.swirlingStrength(0, -7, 7, 0), 7);
  assert.equal(vortices.swirlingStrength(0, 7, 0, 0), 0);
  assert.equal(vortices.swirlingStrength(2, 0, 0, -2), 0);
});

test("scene transforms preserve area and overlapping shapes produce a union", () => {
  const first = { ...geometry.PRESETS.splitter, id: "a", rotation: 0 };
  const second = scene.moveShape(first, .05, .1);
  const rotated = scene.rotateShape(first, 15);
  assert.ok(Math.abs(geometry.signedArea(first.points) - geometry.signedArea(rotated.points)) < 1e-10);
  const a = geometry.maskFor(first.points), b = geometry.maskFor(second.points), union = scene.sceneMask([first.points, second.points]);
  for (let i = 0; i < union.length; i++) assert.equal(union[i], a[i] || b[i]);
  assert.equal(scene.sceneError({ shapes: [first, { ...second, id: "b" }], selectedId: "a" }), null);
  assert.match(scene.sceneError({ shapes: [scene.moveShape(first, 0, -1)], selectedId: "a" }), /above the ground/);
});

test("passive smoke advects downstream, stays bounded and clears solid cells", () => {
  const { NX, NY } = geometry, n = NX * NY, field = new Float32Array(3 * n), solid = new Float32Array(n);
  field.fill(1, 0, n);
  const dye = new FlowDye();
  for (let y = 35; y < 45; y++) for (let x = 30; x < 40; x++) dye.values[y*NX+x] = 1;
  for (let y = 35; y < 45; y++) solid[y*NX+100] = 1;
  for (let step = 0; step < 20; step++) dye.step(field, solid, .03);
  assert.ok(dye.values.every(x => Number.isFinite(x) && x >= 0 && x <= 1));
  let sum = 0, weighted = 0;
  // The separately injected inlet rake has not reached x=30 during this interval.
  for (let y = 30; y < 50; y++) for (let x = 30; x < NX; x++) { sum += dye.values[y*NX+x]; weighted += x * dye.values[y*NX+x]; }
  assert.ok(weighted / sum > 45, "the original smoke patch moves downstream");
  for (let i = 0; i < n; i++) if (solid[i]) assert.equal(dye.values[i], 0);
});
after(() => server?.close());

test("empty tunnel preserves equilibrium velocity and gauge pressure", async () => {
  const nx = 64, ny = 24, n = nx * ny;
  const solver = new BrowserLBM(nx, ny, new Float32Array(n));
  try {
    solver.advance(100);
    const field = await solver.field();
    assert.ok(field.slice(0, n).every(u => Math.abs(u - 1) < 1e-4));
    assert.ok(field.slice(n, 2 * n).every(v => Math.abs(v) < 1e-4));
    assert.ok(field.slice(2 * n).every(cp => Math.abs(cp) < .001));
  } finally { solver.dispose(); }
});

test("all preset outlines resolve to solid cells and reject crossing edits", () => {
  for (const preset of Object.values(geometry.PRESETS)) {
    assert.ok(geometry.validProfile(preset.points), preset.name);
    assert.ok(geometry.maskFor(preset.points, geometry.NX, geometry.NY, preset.vehicle ? {width:20,height:7} : geometry.DOMAIN).reduce((a, b) => a + b, 0) > 30);
  }
  assert.equal(geometry.validProfile([{x:0,y:0},{x:1,y:1},{x:0,y:1},{x:1,y:0}]), false);
  assert.equal(geometry.validProfile([{x:0,y:0},{x:1,y:0}]), false);
});

test("splitter field remains finite, diverts flow and masks solid velocity", async () => {
  const { NX, NY, PRESETS, maskFor } = geometry, n = NX * NY;
  const mask = maskFor(PRESETS.splitter.points), solver = new BrowserLBM(NX, NY, mask);
  try {
    let field;
    for (let i = 0; i < 20; i++) {
      solver.advance(160); field = await solver.field();
      assert.ok(field.every(Number.isFinite), `step ${solver.steps}`);
    }
    assert.ok(field.subarray(0, n).reduce((a, b) => Math.max(a, b), 0) > 1.15, "flow accelerates around the splitter");
    assert.ok(field.subarray(n, 2*n).reduce((a, b) => Math.max(a, Math.abs(b)), 0) > .05, "flow diverts around the outline");
    for (let i = 0; i < n; i++) if (mask[i]) { assert.equal(field[i], 0); assert.equal(field[n+i], 0); }
    assert.ok(field.subarray(2*n).reduce((a, b) => Math.max(a, Math.abs(b)), 0) < 10, "pressure stays bounded");
  } finally { solver.dispose(); }
});
