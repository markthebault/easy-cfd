import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, road, model;
before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  road = await server.ssrLoadModule("/src/geometry/roadPosition.ts");
  model = await server.ssrLoadModule("/src/geometry/model.ts");
});
after(async () => server?.close());
const part = (name, low, high, enabled = true) => ({
  name, file: `${name}.stl`, base: true, enabled, role: name.includes("wheel") ? "wheel" : "body",
  positions: new Float32Array([0, 0, low, 1, 0, high, 0, 1, high]),
});

test("grounding anchors to enabled wheel vertices and falls back to model bottom", () => {
  const body = part("body", -0.2, 0.5), wheel = part("wheel", 0.1, 0.7), disabled = part("wheel_disabled", -1, -0.5, false);
  const position = road.roadPosition([body, wheel, disabled]);
  assert.equal(position.wheels, 1);
  assert.ok(Math.abs(position.height - 0.1) < 1e-7);
  assert.ok(Math.abs(position.lowest + 0.2) < 1e-7);
  assert.equal(road.roadPosition([body, disabled]).wheels, 0);
  assert.equal(road.roadPosition([]).height, null);
});

test("grounding and lifting translate the complete assembly without altering source geometry", () => {
  const raw = [part("body", 0.3, 1), part("wheel_front", 0.2, 0.8), { ...part("wing", 1.2, 1.3), base: false }];
  const original = raw.map(p => p.positions.slice());
  const opts = { ...model.DEFAULT_IMPORT, split: false, clearance: 0.05 };
  const initial = model.buildParts(raw, opts);
  let parts = initial;
  for (const target of [0, 0.15, 1.2, 0.005]) {
    const nextClearance = road.clearanceForRoadHeight(opts.clearance, road.roadPosition(initial).height, target);
    parts = model.buildParts(raw, { ...opts, clearance: nextClearance });
    assert.ok(Math.abs(road.roadPosition(parts).height - target) < 1e-7);
    for (let p = 0; p < parts.length; p++) for (let i = 0; i < parts[p].positions.length; i++) {
      const expected = initial[p].positions[i] + (i % 3 === 2 ? target - road.roadPosition(initial).height : 0);
      assert.ok(Math.abs(parts[p].positions[i] - expected) < 2e-7);
    }
  }
  raw.forEach((p, i) => assert.deepEqual(p.positions, original[i]));
});

test("simulation gap clears the lowest enabled part even when it hangs below the wheels", () => {
  const parts = [part("body", -0.2, 0.5), part("wheel", 0.1, 0.7)];
  const position = road.roadPosition(parts);
  const delta = road.clearanceForRoadHeight(0, position.lowest, 0.005);
  assert.ok(Math.abs(position.lowest + delta - 0.005) < 1e-10);
  assert.ok(position.height + delta > 0.005);
});
