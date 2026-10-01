import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, pressure, analysis;
before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  [pressure, analysis] = await Promise.all([server.ssrLoadModule("/src/viz/pressureCloud.ts"), server.ssrLoadModule("/src/viz/analysis.ts")]);
});
after(async () => server?.close());

function field() {
  const dims = [5, 5, 5], n = 125;
  const f = { dims, origin: [-2, -2, 0], spacing: [1, 1, 1], freestream: 10, length: 4, inlet: [10, 0, 0], u: new Float32Array(n).fill(10), v: new Float32Array(n), w: new Float32Array(n), p: new Float32Array(n), k: new Float32Array(n), solid: new Uint8Array(n) };
  for (let k = 0; k < 5; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) f.p[i + 5 * (j + 5 * k)] = (i - 2) * 50;
  return f;
}

test("pressure clouds reproduce the analytic Cp plane, including suction", () => {
  const f = field(), cp = pressure.pressureCoefficients(f);
  assert.equal(cp[0], -2);
  for (const level of [-0.5, 0.5]) {
    const g = pressure.pressureCloudGeometry(f, cp, level);
    assert.ok(g.index.count > 0);
    const pos = g.getAttribute("position");
    for (let v = 0; v < pos.count; v++) assert.ok(Math.abs(pos.getX(v) - level) < 1e-6);
    g.dispose();
  }
});

test("missing or solid samples never create pressure clouds; unreachable thresholds are empty", () => {
  const f = field();
  f.solid.fill(1);
  let g = pressure.pressureCloudGeometry(f, pressure.pressureCoefficients(f), 0.5);
  assert.equal(g.index.count, 0);
  g.dispose();
  f.solid.fill(0);
  g = pressure.pressureCloudGeometry(f, pressure.pressureCoefficients(f), 3);
  assert.equal(g.index.count, 0);
  g.dispose();
  f.p.fill(NaN);
  g = pressure.pressureCloudGeometry(f, pressure.pressureCoefficients(f), 0.5);
  assert.equal(g.index.count, 0);
  assert.ok([...g.getAttribute("position").array].every(Number.isFinite));
  g.dispose();
});

test("horizontal presets cover car width, vertical presets cover height, and both stay in the fluid box", () => {
  const f = field();
  const viz = { stream: { count: 24, animate: true }, playing: false };
  const bounds = { low: [-1, -1.5, 0.2], high: [1, 1.5, 1.2] };
  const vertical = analysis.analysisPreset("vertical", viz, f, bounds);
  const horizontal = analysis.analysisPreset("horizontal", viz, f, bounds);
  assert.ok(horizontal.stream.length > vertical.stream.length * 2);
  for (const preset of [vertical, horizontal]) {
    const s = preset.stream, axis = s.orientation === "horizontal" ? 1 : 2;
    const center = axis === 1 ? s.y : s.z;
    assert.ok(center - s.length / 2 >= f.origin[axis]);
    assert.ok(center + s.length / 2 <= f.origin[axis] + 4);
    assert.equal(preset.smoke, false);
    assert.equal(preset.pressureCloud, false);
    assert.equal(analysis.activeAnalysis(preset), s.orientation);
  }
  assert.equal(analysis.activeAnalysis({ ...horizontal, smoke: true }), null);
});
