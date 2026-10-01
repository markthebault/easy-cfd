import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
let server, aero, codec;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  aero = await server.ssrLoadModule("/src/solver/aero.ts");
  codec = await server.ssrLoadModule("/src/store/codec.ts");
});
after(async () => server?.close());
const axles = { frontX: -1, rearX: 2, centrelineY: 0, confirmed: true };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} vs ${b}`);
test("wall moments give front, rear and middle loads; sums conserve lift and Cl", () => {
  for (const [x, front, rear] of [
    [-1, -90, 0],
    [2, 0, -90],
    [0.5, -45, -45],
  ]) {
    const f = [0, 0, -90],
      m = aero.momentAt([x, 0, 0], f, [-1, 0, 0]),
      b = aero.equivalentLoads(f, m, axles, 450);
    close(b.frontLift, front);
    close(b.rearLift, rear);
    close(b.frontCl + b.rearCl, -0.2);
  }
});
test("pure couple, drag at height, mixed loads and zero lift do not fabricate percentages", () => {
  const b = aero.equivalentLoads([0, 0, 0], [0, 90, 0], axles, 450);
  close(b.rearLift, -30);
  close(b.frontLift, 30);
  assert.equal(b.frontDownforcePercent, undefined);
  const drag = aero.equivalentLoads(
    [90, 0, 0],
    aero.momentAt([0.5, 0, 1], [90, 0, 0], [-1, 0, 0]),
    axles,
    450,
  );
  close(drag.pitch, 90);
  close(drag.frontLift, 30);
  close(drag.rearLift, -30);
  assert.match(b.percentageReason, /zero/);
  const mix = aero.equivalentLoads([0, 0, -30], [0, 180, 0], axles, 450);
  assert.match(mix.percentageReason, /Both/);
});
test("translation of complete car and OpenFOAM origin preserves equivalent loads", () => {
  const f = [80, 12, -100],
    p = [0.5, 0.2, 0.7],
    o = [-1, 0, 0],
    offset = [7, -3, 2];
  const translate = (a) => a.map((v, i) => v + offset[i]);
  const m = aero.momentAt(p, f, o),
    other = aero.momentAt(translate(p), f, translate(o));
  m.forEach((v, i) => close(v, other[i]));
  const b = aero.equivalentLoads(f, m, axles, 450),
    b2 = aero.equivalentLoads(
      f,
      other,
      { ...axles, frontX: 6, rearX: 9, centrelineY: -3 },
      450,
    );
  close(b.frontLift, b2.frontLift);
  close(b.rearLift, b2.rearLift);
});
test("invalid and unconfirmed axles are unavailable; ambiguous wheels do not suggest box ends", () => {
  assert.equal(
    aero.equivalentLoads(
      [0, 0, -10],
      [0, 0, 0],
      { ...axles, confirmed: false },
      450,
    ),
    undefined,
  );
  assert.equal(aero.suggestAxles([]), undefined);
  assert.match(aero.axleError({ ...axles, frontX: 3 }), /smaller/);
  const wheels = [
    [-1, -0.7],
    [-1, 0.7],
    [2, -0.7],
    [2, 0.7],
  ].map(([x, y], i) => ({
    id: `w${i}`,
    role: "wheel",
    wheel: { center: [x, y, 0.3], radius: 0.3 },
  }));
  assert.deepEqual(aero.suggestAxles(wheels), {
    frontX: -1,
    rearX: 2,
    centrelineY: 0,
    confirmed: false,
  });
});
test("physical stress and validity survive storage without quantization; old samples remain unsupported", () => {
  const s = {
    cp: new Float32Array([0, 1, NaN]),
    shear: new Float32Array(9),
    wallStress: new Float32Array([0, 0, 0, 3, 4, 0, NaN, NaN, NaN]),
    stressValid: new Uint8Array([1, 1, 2]),
    snapshot: {
      iteration: 120,
      grid: "test",
      unit: "Pa",
      dynamicPressure: 100,
    },
  };
  const actual = codec.decodeSurface(codec.encodeSurface(["part"], [s]))[0];
  assert.deepEqual(actual.wallStress, s.wallStress);
  assert.deepEqual(actual.stressValid, s.stressValid);
  assert.equal(Math.hypot(...actual.wallStress.slice(3, 6)), 5);
  const old = codec.decodeSurface([
    { cp: codec.quantize(s.cp), shear: codec.quantize(s.shear) },
  ])[0];
  assert.equal(old.wallStress, undefined);
});

test("resource preflight rejects over-budget grids and device buffers before preparation", async () => {
  const { preflight } = await server.ssrLoadModule("/src/solver/resources.ts");
  assert.throws(() => preflight(3_000_000, 3_200_000, 10000), /2.5 M/);
  assert.throws(() => preflight(1_500_000, 1_800_000, 400_000_000), /GiB/);
  assert.throws(
    () => preflight(1_500_000, 1_800_000, 1000, 16 * 1024 ** 2),
    /GPU/,
  );
  assert.ok(
    preflight(1_500_000, 1_800_000, 1000, 128 * 1024 ** 2).bytes <
      3 * 1024 ** 3,
  );
});
