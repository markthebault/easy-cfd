// OpenFOAM engine mappings: settings, frames and run records. Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, of, types;

before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  [of, types] = await Promise.all([server.ssrLoadModule("/src/engine/openfoam.ts"), server.ssrLoadModule("/src/solver/types.ts")]);
});
after(async () => server?.close());

test("UI settings map to the server's settings; Custom quality becomes Medium", () => {
  const s = { ...types.DEFAULT_SETTINGS, quality: "custom", speed_kmh: 130, yaw_deg: 5, simulation_box: { x_min: -10, x_max: 20, y_min: -5, y_max: 5, z_max: 6 } };
  const out = of.serverSettings(s);
  assert.equal(out.quality, "medium");
  assert.equal(out.speed_kmh, 130);
  assert.equal(out.yaw_deg, 5);
  assert.deepEqual(out.simulation_box, s.simulation_box);
  assert.equal(out.geometry_confirmed, true);
  // Only fields the server accepts (its model forbids extra ones).
  assert.deepEqual(Object.keys(out).sort(), ["custom_iterations", "custom_mesh", "density", "geometry_confirmed", "moving_ground", "quality", "reference_area", "simulation_box", "speed_kmh", "wheels", "yaw_deg"]);
});

test("frame offset and domain conversion between the UI and the server", () => {
  const uiLow = [-2.1, -0.9, 0.01];
  const serverLow = [-2.05, -0.92, 0.01];
  const off = of.frameOffset(uiLow, serverLow);
  assert.ok(Math.abs(off[0] - 0.05) < 1e-12 && Math.abs(off[1] + 0.02) < 1e-12 && off[2] === 0);
  const d = of.domainToUi([-14, 26, -9, 9, 0, 9.5], off);
  assert.ok(Math.abs(d[0] + 14.05) < 1e-12 && Math.abs(d[2] + 8.98) < 1e-12 && d[4] === 0 && d[5] === 9.5);
  const soup = new Float32Array([1, 2, 3, -1, 5, 0.5, 0, -2, 7]);
  assert.deepEqual(of.soupLow(soup), [-1, -2, 0.5]);
});

test("a server run record becomes a UI run result", () => {
  const rec = {
    id: "a".repeat(32), project_id: "b".repeat(32), name: "x", created: "2026-09-28T10:00:00Z", status: "completed",
    started: "2026-09-28T10:00:00Z", finished: "2026-09-28T10:10:00Z", iteration: 300,
    settings: { speed_kmh: 100, yaw_deg: 0, quality: "fast", reference_area: 2, density: 1.225 },
    domain: [-14, 26, -9, 9, 0, 9.5],
    geometry: { parts: [] },
    result: {
      cd: 0.35, cl: -0.05, drag: 330, downforce: 47, force_settled: true, cd_span: 0.004, cl_span: 0.01, averaging_iterations: 50,
      history: [{ iteration: 1, cd: 1, cl: 0 }, { iteration: 2, cd: 0.5, cl: 0.1 }],
      breakdown: { body: { pressure_drag: 250, viscous_drag: 12, pressure_downforce: 40, viscous_downforce: 1 }, wheels: { pressure_drag: 60, viscous_drag: 8, pressure_downforce: 6, viscous_downforce: 0 } },
      blockage_ratio: 0.012, cells: 350000, iteration: 300, warnings: ["w"], residuals: { p: 1e-3 }, residual_converged: false,
    },
  };
  const r = of.resultFromRecord(rec, 4.0, [0.05, 0, 0], [0, 0, 0, 0, 0, 0]);
  assert.equal(r.engine, "openfoam");
  assert.equal(r.cd, 0.35);
  assert.equal(r.lift, -47);
  assert.equal(r.downforce, 47);
  assert.deepEqual(r.breakdown.bodyPressure, [250, 0, -40]);
  assert.deepEqual(r.breakdown.wheelViscous, [8, 0, -0]);
  assert.equal(r.wallSeconds, 600);
  assert.equal(r.cdBand, 0.002);
  assert.deepEqual(r.history[1], { time: 2, step: 2, cd: 0.5, cl: 0.1, cs: 0 });
  assert.ok(Math.abs(r.domain[0] + 14.05) < 1e-12);
  assert.equal(r.openfoam.iterations, 300);
  assert.equal(r.openfoam.averagingIterations, 50);
  assert.equal(r.gridId, `openfoam:${rec.id}`);
  assert.ok(Math.abs(r.freestream - 100 / 3.6) < 1e-12);
});
