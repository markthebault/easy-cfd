import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, pressure, analysis, streams;
before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  [pressure, analysis, streams] = await Promise.all([server.ssrLoadModule("/src/viz/pressureCloud.ts"), server.ssrLoadModule("/src/viz/analysis.ts"), server.ssrLoadModule("/src/viz/streamlines.ts")]);
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

test("overview combines pressure and streamlines, and switching presets restores a single rake", () => {
  const f = field(), bounds = { low: [-1, -1, 0.2], high: [1, 1, 1.2] };
  const overview = analysis.analysisPreset("overview", { stream: {} }, f, bounds);
  assert.equal(analysis.activeAnalysis(overview), "overview");
  assert.equal(analysis.activeAnalysis({ ...overview, slice: true }), null);
  const vertical = { ...overview, ...analysis.analysisPreset("vertical", overview, f, bounds) };
  assert.equal(analysis.activeAnalysis(vertical), "vertical");
  assert.equal(vertical.stream.layout, "single");
  assert.equal(vertical.surface, false);
  const seeds = streams.overviewSeeds(f, { center: new THREE.Vector3(-1.5, 0, 0.8), length: 1.2, count: 12, orientation: "vertical" }, bounds);
  assert.equal(new Set(seeds.filter(s => s.position[0] < bounds.low[0]).map(s => s.position[1])).size, 3);
  assert.ok(seeds.some(s => s.both && s.position[0] > bounds.high[0]));
  assert.ok(seeds.every(s => s.position.every((v, a) => v >= f.origin[a] && v <= f.origin[a] + f.spacing[a] * (f.dims[a] - 1))));
});

test("local seeds reveal an isolated analytic vortex that upstream streamlines miss", () => {
  const dims = [51, 41, 3], n = dims.reduce((a,b) => a*b), spacing = [0.1, 0.1, 0.1];
  const f = { dims, spacing, origin: [-2, -2, -0.1], freestream: 10, length: 4,
    u: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n), p: new Float32Array(n), k: new Float32Array(n), solid: new Uint8Array(n) };
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
    const x = -2 + i * 0.1, y = -2 + j * 0.1, idx = i + dims[0] * (j + dims[1] * k);
    if (Math.hypot(x - 1, y) < 0.85) { f.u[idx] = -y; f.v[idx] = x - 1; }
    else f.u[idx] = 10;
  }
  const [upstream] = streams.traceSeeds(f, [{ position: [-1.5, 1.4, 0] }]);
  assert.ok(upstream.speed.every(v => Math.abs(v - 10) < 1e-5));
  const [vortex] = streams.traceSeeds(f, [{ position: [1.5, 0, 0], both: true, maxLength: 1 }]);
  assert.ok(vortex.tof[0] < 0 && vortex.tof.at(-1) > 0);
  for (let i = 0; i < vortex.speed.length; i++) {
    assert.ok(Math.abs(Math.hypot(vortex.pts[i * 3] - 1, vortex.pts[i * 3 + 1]) - 0.5) < 0.002);
    if (i) assert.ok(vortex.tof[i] > vortex.tof[i - 1]);
  }
  const [closed] = streams.traceSeeds(f, [{ position: [1.5, 0, 0], both: true, maxLength: 10 }]);
  assert.equal(closed.closed, true);
  assert.ok(closed.speed.length < 70, "stop after one orbit, rather than drawing duplicate loops");
  f.solid.fill(1);
  assert.deepEqual(streams.traceSeeds(f, [{ position: [1.5, 0, 0], both: true }]), []);
  f.solid.fill(0); f.u.fill(NaN);
  assert.deepEqual(streams.traceSeeds(f, [{ position: [1.5, 0, 0] }]), []);
});
