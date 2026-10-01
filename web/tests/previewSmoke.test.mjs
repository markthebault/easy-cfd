import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, smoke;
before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  smoke = await server.ssrLoadModule("/src/viz/previewSmoke.ts");
});
after(async () => server?.close());
const box = (x, y, z, cx, cy, cz) => {
  const g = new THREE.BoxGeometry(x, y, z).toNonIndexed().translate(cx, cy, cz);
  const p = g.getAttribute("position").array.slice(); g.dispose(); return p;
};
test("five preview streams clear the body and rise over a taller roof", () => {
  const body = box(4, 1.8, 0.5, 0, 0, 0.45), roof = box(1.6, 1.2, 0.6, 0, 0, 0.95);
  const original = body.slice();
  const paths = smoke.previewSmokePaths([body, roof]);
  assert.equal(paths.length, 5);
  for (const path of paths) {
    assert.ok(Array.from(path).every(Number.isFinite));
    for (let i = 3; i < path.length; i += 3) assert.ok(path[i] > path[i - 3]);
  }
  for (const path of paths.slice(0, 3)) {
    for (let i = 0; i < path.length; i += 3) if (Math.abs(path[i]) < 0.75) assert.ok(path[i + 2] > 1.25);
    assert.ok(path[2] < 0.9);
  }
  for (let i = 0; i < paths[3].length; i += 3) if (Math.abs(paths[3][i]) < 1.8) {
    assert.ok(paths[3][i + 1] < -0.9);
    assert.ok(paths[4][i + 1] > 0.9);
  }
  assert.deepEqual(body, original);
});
test("preview smoke follows crosswind and needs no geometry or solver state", () => {
  const body = box(4, 1.8, 0.5, 0, 0, 0.45);
  const path = smoke.previewSmokePaths([body], 12 * Math.PI / 180)[1];
  const last = path.length - 3;
  assert.ok(Math.abs((path[last + 1] - path[1]) / (path[last] - path[0]) - Math.tan(12 * Math.PI / 180)) < 1e-6);
  assert.deepEqual(smoke.previewSmokePaths([]), []);
});
