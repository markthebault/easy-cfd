// CPU-side solver and geometry checks. TypeScript modules are loaded through Vite's SSR loader.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, grid, vox, cut, model, sample, stl, setup, types;

before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  [grid, vox, cut, model, sample, stl, setup, types] = await Promise.all(
    ["grid", "voxelize", "cutcell"].map((m) => server.ssrLoadModule(`/src/solver/${m}.ts`))
      .concat(["model", "sample", "stl"].map((m) => server.ssrLoadModule(`/src/geometry/${m}.ts`)))
      .concat([server.ssrLoadModule("/src/solver/setup.ts"), server.ssrLoadModule("/src/solver/types.ts")]),
  );
});
after(async () => server?.close());

const car = () => sample.sampleCar(false);
const bodyVolume = () => model.soupBounds && vox.meshVolumeArea(car()[0].positions).volume;

test("stretched axis: uniform refined region, exact ends, multigrid-friendly count", () => {
  const a = grid.buildAxis({ lo: -10, hi: 20, fineLo: -2, fineHi: 5, h: 0.05, growthLo: 1.15, growthHi: 1.08, hmax: 0.8 }, 16);
  assert.equal(a.n % 16, 0);
  assert.ok(Math.abs(a.faces[0] + 10) < 1e-12 && Math.abs(a.faces[a.n] - 20) < 1e-9);
  for (let i = 0; i < a.n; i++) assert.ok(a.widths[i] > 0);
  const inFine = [...a.centers].map((c, i) => [c, a.widths[i]]).filter(([c]) => c > -1.9 && c < 4.9);
  for (const [, w] of inFine) assert.ok(Math.abs(w - 0.05) < 1e-9, `fine width ${w}`);
  // growth ratio between neighbours stays bounded (halving splits allowed in the far field)
  for (let i = 1; i < a.n; i++) {
    const r = a.widths[i] / a.widths[i - 1];
    assert.ok(r < 2.01 && r > 0.49, `ratio ${r}`);
  }
});

test("sample car geometry matches the OpenFOAM app's sample", () => {
  const parts = car();
  assert.equal(parts.length, 5);
  assert.equal(parts[0].positions.length / 9, 24);
  for (const w of parts.slice(1)) assert.equal(w.positions.length / 9, 128);
  const { low, high } = model.soupBounds(parts.map((p) => p.positions));
  assert.deepEqual(low.map((v) => +v.toFixed(3)), [-2.1, -1.17, 0.01]);
  assert.deepEqual(high.map((v) => +v.toFixed(3)), [2.1, 1.17, 1.32]);
  assert.ok(vox.meshVolumeArea(parts[0].positions).volume > 0, "outward winding");
  assert.equal(sample.sampleCar(true).length, 6);
});

function testGrid(cellsPerLength = 60) {
  const parts = car();
  const { low, high } = setup.boundsOf(parts);
  const domain = grid.automaticDomain(low, high);
  return { parts, g: grid.buildGrid({ domain, low, high, cellsPerLength, levels: 5 }) };
}

test("voxel volume of the body is within 6 % of the mesh volume", () => {
  const { parts, g } = testGrid();
  const r = vox.voxelize(g, [parts[0]]);
  let v = 0;
  for (let k = 0; k < g.z.n; k++)
    for (let j = 0; j < g.y.n; j++)
      for (let i = 0; i < g.x.n; i++) if (r.solid[i + g.x.n * (j + g.y.n * k)]) v += g.x.widths[i] * g.y.widths[j] * g.z.widths[k];
  const exact = bodyVolume();
  assert.ok(Math.abs(v - exact) / exact < 0.06, `voxel ${v} vs ${exact}`);
});

test("cut-cell fluid fractions reproduce the body volume within 2 %", () => {
  const { parts, g } = testGrid();
  const ng = cut.nodeGrid(g);
  const inside = vox.voxelize(ng, [parts[0]], false).solid;
  const nd = cut.nodeDistance(ng, [parts[0]], 2.5 * g.h);
  const sdf = nd.dist.map((d, n) => (inside[n] ? -d : d));
  const fr = cut.fractions(g, sdf, nd.part);
  let solidVolume = 0;
  for (let k = 0; k < g.z.n; k++)
    for (let j = 0; j < g.y.n; j++)
      for (let i = 0; i < g.x.n; i++) {
        const c = i + g.x.n * (j + g.y.n * k);
        solidVolume += (1 - fr.theta[c]) * g.x.widths[i] * g.y.widths[j] * g.z.widths[k];
      }
  const exact = bodyVolume();
  assert.ok(Math.abs(solidVolume - exact) / exact < 0.02, `cut ${solidVolume} vs ${exact}`);
});

test("prepared case: closed wall surface, sensible frontal area, divisible multigrid levels", () => {
  const s = setup.prepareCase(car().map((p, i) => ({ ...p, id: `p${i}` })), { ...types.DEFAULT_SETTINGS, quality: "custom", custom_cells: 50 });
  let sx = 0, sy = 0, sz = 0, projected = 0;
  for (let q = 0; q < s.faceCount; q++) {
    const g = s.faces[2 * q];
    sx += s.wall[4 * g];
    sy += s.wall[4 * g + 1];
    sz += s.wall[4 * g + 2];
    projected += Math.max(0, s.wall[4 * g]);
  }
  for (let q = 0; q < s.faceCount; q++) if ((s.faces[2 * q + 1] >> 17) & 1) projected -= 0; // contact faces are vertical only
  const total = projected * 2;
  assert.ok(Math.abs(sx) < 1e-3 * total && Math.abs(sy) < 1e-3 * total && Math.abs(sz) < 1e-3 * total, `open wall sum ${sx} ${sy} ${sz}`);
  // Forward-facing wall area counts body and all four wheels (rear wheels are hidden in projection).
  const forward = 1.62 * 1.0 + 4 * 0.24 * 0.64;
  assert.ok(Math.abs(projected - forward) / forward < 0.15, `forward-facing wall ${projected} vs ${forward}`);
  for (let l = 1; l < s.levels.length; l++) assert.equal(s.levels[l].nx * 2, s.levels[l - 1].nx);
  assert.equal(s.sealedCells, 0);
});

test("frontal area of the sample car", () => {
  // Body 1.62 × 1.0 plus two visible 0.24 × 0.64 wheel discs (rear wheels hide behind the front ones).
  const a = model.frontalArea(car().map((p) => p.positions));
  const disc = 0.24 * 0.64 - 0.24 * (0.64 - 0.32 * Math.PI / 2) * 0; // rectangle projection of a cylinder
  assert.ok(Math.abs(a - (1.62 + 2 * disc)) < 0.03, `frontal ${a}`);
});

test("STL binary round trip and ASCII parsing", () => {
  const body = car()[0].positions;
  const back = stl.parseSTL(stl.writeSTL(body));
  assert.equal(back.length, body.length);
  for (let i = 0; i < body.length; i++) assert.ok(Math.abs(back[i] - body[i]) < 1e-6);
  const ascii = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
  assert.deepEqual(Array.from(stl.parseSTL(new TextEncoder().encode(ascii).buffer)), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test("connected components and axis conversion", () => {
  const all = car();
  const soup = new Float32Array(all.reduce((n, p) => n + p.positions.length, 0));
  let o = 0;
  for (const p of all) {
    soup.set(p.positions, o);
    o += p.positions.length;
  }
  assert.equal(model.splitComponents(soup).length, 5);
  // A model exported with its nose toward +Y and up +Z ends with the nose toward −X.
  const m = model.orientation("+Y", "+Z");
  const nose = [m[0] * 0 + m[1] * 1 + m[2] * 0, m[3] * 0 + m[4] * 1 + m[5] * 0, m[6] * 0 + m[7] * 1 + m[8] * 0];
  assert.deepEqual(nose.map((v) => Math.round(v)), [-1, 0, 0]);
});
