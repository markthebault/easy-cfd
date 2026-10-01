import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, motion, centroid;
before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  motion = await server.ssrLoadModule("/src/viz/driving.ts");
  centroid = await server.ssrLoadModule("/src/geometry/centroid.ts");
});
after(async () => server?.close());

test("wind yaw adds a lateral component while longitudinal road speed is unchanged", () => {
  const conditions = { speed_kmh: 108, yaw_deg: 0, moving_ground: true, wheels: true };
  assert.deepEqual(motion.drivingVelocity(conditions), [30, 0, 0]);
  for (const yaw_deg of [-20, 12, 20]) {
    const [x, y] = motion.drivingVelocity({ ...conditions, yaw_deg });
    assert.equal(x, 30);
    assert.ok(Math.abs(Math.atan2(y, x) - yaw_deg * Math.PI / 180) < 1e-12);
  }
});

test("a rotating tyre travels one circumference per revolution with positive bottom tread velocity", () => {
  for (const radius of [0.2, 0.32, 0.5]) {
    const distance = 2 * Math.PI * radius;
    assert.ok(Math.abs(motion.rollingAngle(distance, radius) + 2 * Math.PI) < 1e-12);
    const omega = motion.rollingAngle(30, radius);
    assert.ok(Math.abs(-omega * radius - 30) < 1e-12);
  }
  assert.equal(motion.rollingAngle(1, 0), 0);
});

// An asymmetric closed tetrahedron has a volume centroid distinct from its bounding-box center.
const tetrahedron = () => new Float32Array([
  0, 0, 0, 0, 3, 0, 4, 0, 0,
  0, 0, 0, 4, 0, 0, 0, 0, 2,
  0, 0, 0, 0, 0, 2, 0, 3, 0,
  4, 0, 0, 0, 3, 0, 0, 0, 2,
]);
test("wheel pivot is the volume centroid rather than the bounds midpoint", () => {
  assert.deepEqual(centroid.wheelCenterOfMass(tetrahedron(), [2, 1.5, 1]), [1, 0.75, 0.5]);
});
test("wheel centroid follows translation and scale and tolerates reversed winding", () => {
  const positions = tetrahedron();
  const offset = [80, -40, 12];
  for (let i = 0; i < positions.length; i++) positions[i] = positions[i] * 0.25 + offset[i % 3];
  for (let i = 0; i < positions.length; i += 9) for (let j = 0; j < 3; j++) {
    [positions[i + 3 + j], positions[i + 6 + j]] = [positions[i + 6 + j], positions[i + 3 + j]];
  }
  assert.deepEqual(centroid.wheelCenterOfMass(positions, offset), [80.25, -39.8125, 12.125]);
});
test("open, inconsistent and degenerate wheel meshes retain the imported axle center", () => {
  const fallback = [1, 2, 3];
  const inconsistent = tetrahedron();
  for (let j = 0; j < 3; j++) [inconsistent[3 + j], inconsistent[6 + j]] = [inconsistent[6 + j], inconsistent[3 + j]];
  for (const positions of [tetrahedron().subarray(9), inconsistent, new Float32Array(9), new Float32Array()]) {
    assert.deepEqual(centroid.wheelCenterOfMass(positions, fallback), fallback);
  }
});
