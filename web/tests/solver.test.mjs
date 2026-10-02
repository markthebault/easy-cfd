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

test("exact 500,000-cell mesh keeps the tunnel boundaries and positive widths", () => {
  const parts = car(), { low, high } = setup.boundsOf(parts);
  const domain = grid.automaticDomain(low, high);
  const g = grid.buildGrid({domain,low,high,cellsPerLength:36,levels:5,targetCells:500000});
  assert.equal(g.cells,500000);
  for (const [index,axis] of [g.x,g.y,g.z].entries()) {
    assert.equal(axis.faces[0],domain[2*index]);
    assert.equal(axis.faces[axis.n],domain[2*index+1]);
    assert.ok([...axis.widths].every(w=>Number.isFinite(w) && w>0));
  }
  assert.throws(()=>grid.countsForCells(500003,[160,64,48]),/cannot form/);
});

test("odd-sized multigrid preserves operator energy, including the partial boundary aggregate", () => {
  const c = setup.prepareCase(car(),{...types.DEFAULT_SETTINGS,quality:"custom",custom_cells:36,targetCells:125000});
  assert.ok(c.levels.some(l=>l.nx%2 || l.ny%2 || l.nz%2));
  const energy = (l,v) => {
    let sum=0;
    for(let k=1;k<=l.nz;k++) for(let j=1;j<=l.ny;j++) for(let i=1;i<=l.nx;i++) {
      const q=i+l.NX*(j+l.NY*k), g=l.coef;
      sum+=g[4*q+3]*v[q]**2;
      for(const [a,offset,inside] of [[0,1,i<l.nx],[1,l.NX,j<l.ny],[2,l.NX*l.NY,k<l.nz]]) if(inside) sum+=g[4*q+a]*(v[q+offset]-v[q])**2;
    }
    return sum;
  };
  for(let n=0;n<c.levels.length-1;n++) {
    const fine=c.levels[n],coarse=c.levels[n+1];
    const u=new Float64Array(coarse.NC),v=new Float64Array(fine.NC);
    for(let k=1;k<=coarse.nz;k++) for(let j=1;j<=coarse.ny;j++) for(let i=1;i<=coarse.nx;i++) u[i+coarse.NX*(j+coarse.NY*k)]=Math.sin(i*.71+j*.39+k*.23);
    for(let k=1;k<=fine.nz;k++) for(let j=1;j<=fine.ny;j++) for(let i=1;i<=fine.nx;i++) v[i+fine.NX*(j+fine.NY*k)]=u[Math.ceil(i/2)+coarse.NX*(Math.ceil(j/2)+coarse.NY*Math.ceil(k/2))];
    const a=energy(fine,v),b=energy(coarse,u);
    assert.ok(Math.abs(a-b)/Math.max(a,1e-30)<1e-6,`level ${n}: ${a} versus ${b}`);
  }
});

test("cut-cell fluid centroid reproduces an oblique planar wall distance", () => {
  const axis = {n:1,faces:Float64Array.from([0,1]),centers:Float64Array.from([.5]),widths:Float64Array.from([1])};
  const g = {x:axis,y:axis,z:axis,h:1,cells:1};
  const sdf = Float32Array.from([0,1,1,2,0,1,1,2].map(v=>(v-.9)/Math.SQRT2));
  const f = cut.fractions(g,sdf,new Uint8Array(8),true);
  // Integrating the triangle x+y<.9 out of the unit square gives this centroid analytically.
  const volume=1-.9**2/2, centroid=(.5-(.9**2/2)*(.9/3))/volume;
  const expected=(2*centroid-.9)/Math.SQRT2;
  assert.ok(Math.abs(f.centroidWallDistance[0]-expected)<.015);
});

test("geometric cuts integrate a thin road gap without sample quantization", () => {
  const axis={n:1,faces:Float64Array.from([0,1]),centers:Float64Array.from([.5]),widths:Float64Array.from([1])};
  const g={x:axis,y:axis,z:axis,h:1,cells:1};
  const gap=.2, sdf=Float32Array.from(Array.from({length:8},(_,i)=>gap-(i>>2)));
  const f=cut.fractions(g,sdf,new Uint8Array(8),true,true);
  for (const actual of [f.theta[0],f.ax[0],f.ay[0]]) assert.ok(Math.abs(actual-gap)<1e-7);
  assert.equal(f.az[0],0);
  assert.ok(Math.abs(f.centroidHeight[0]-gap/2)<1e-7);
  assert.ok(Math.abs(f.centroidWallDistance[0]-gap/2)<1e-7);
});

test("geometric cuts reproduce oblique-plane volume and centroid analytically", () => {
  const axis={n:1,faces:Float64Array.from([0,1]),centers:Float64Array.from([.5]),widths:Float64Array.from([1])};
  const g={x:axis,y:axis,z:axis,h:1,cells:1};
  const offset=.6;
  const sdf=Float32Array.from(Array.from({length:8},(_,i)=>((i&1)+((i>>1)&1)+((i>>2)&1)-offset)/Math.sqrt(3)));
  const f=cut.fractions(g,sdf,new Uint8Array(8),true,true);
  const solidVolume=offset**3/6, volume=1-solidVolume;
  const centroid=(.5-solidVolume*offset/4)/volume;
  assert.ok(Math.abs(f.theta[0]-volume)<1e-7);
  assert.ok(Math.abs(f.centroidHeight[0]-centroid)<1e-7);
  assert.ok(Math.abs(f.centroidWallDistance[0]-(3*centroid-offset)/Math.sqrt(3))<1e-7);
});

test("clipped tetrahedra conserve complementary volume, first moments and face area", async () => {
  const {clippedCube,clippedFace}=await server.ssrLoadModule("/src/solver/cutGeometry.ts");
  for (const values of [[.2,-.8,.2,-.8,.2,-.8,.2,-.8],[1,-2,3,-4,5,-6,7,-8],[0,.7,-.2,1,-.5,.3,-1,.2]]) {
    const a=clippedCube(values),b=clippedCube(values.map(v=>-v));
    assert.ok(Math.abs(a.volume+b.volume-1)<1e-12);
    for (let i=0;i<3;i++) assert.ok(Math.abs(a.volume*a.centroid[i]+b.volume*b.centroid[i]-.5)<1e-12);
    assert.ok(Math.abs(clippedFace(...values.slice(0,4))+clippedFace(...values.slice(0,4).map(v=>-v))-1)<1e-12);
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

test("road and wheel choices set independent solver wall velocities without changing wind", () => {
  const parts = car().map((p, i) => ({ ...p, id: `p${i}` }));
  const speed = 108 / 3.6;
  for (const moving_ground of [false, true]) for (const wheels of [false, true]) {
    const c = setup.prepareCase(parts, { ...types.DEFAULT_SETTINGS, quality: "custom", custom_cells: 40, speed_kmh: 108, yaw_deg: 10, moving_ground, wheels });
    assert.equal(c.groundSpeed, moving_ground ? speed : 0);
    assert.equal(c.inlet[0], speed);
    assert.ok(Math.abs(c.inlet[1] - speed * Math.tan(10 * Math.PI / 180)) < 1e-6);
    assert.equal(c.parts[3], 0, "body stays fixed");
    parts.forEach((p, i) => {
      if (p.role !== "wheel") return;
      const omega = c.parts[4 * i + 3];
      assert.ok(Math.abs(omega - (wheels ? -speed / p.wheel.radius : 0)) < 1e-5);
      if (wheels) assert.deepEqual(Array.from(c.parts.slice(4 * i, 4 * i + 3)), p.wheel.center.map(Math.fround));
    });
  }
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

test("window statistics and moving average of force history", async () => {
  const ws = await server.ssrLoadModule("/src/ui/windowStats.ts");
  // Synthetic history: 1 s per pass, 10 samples per pass, Cd constant 0.3, Cl a square wave 0.1/0.3.
  const history = Array.from({ length: 50 }, (_, i) => ({ time: 0.1 * (i + 1), step: i, cd: 0.3, cl: i % 2 ? 0.3 : 0.1, cs: 0 }));
  const s = ws.trailingStats(history, 1, 2);
  assert.ok(Math.abs(s.from - 3) < 1e-9);
  assert.equal(s.cd.n, 21);
  assert.ok(Math.abs(s.cd.mean - 0.3) < 1e-12 && s.cd.min === 0.3 && s.cd.max === 0.3);
  assert.equal(s.cl.min, 0.1);
  assert.equal(s.cl.max, 0.3);
  assert.ok(Math.abs(s.cl.median - 0.3) < 1e-12, `median ${s.cl.median}`); // 11 highs of 21
  const ma = ws.movingAverage(history, 1);
  assert.equal(ma.length, history.length);
  assert.ok(Math.abs(ma[0].cl - 0.1) < 1e-12);
  for (const m of ma.slice(20)) assert.ok(Math.abs(m.cl - 0.2) < 0.011, `ma ${m.cl}`);
  assert.equal(ws.trailingStats(history.slice(0, 2), 1, 2), null);
});

// Closed axis-aligned box as a triangle soup (outward winding).
function boxSoup(x0, x1, y0, y1, z0, z1) {
  const p = (i, j, k) => [i ? x1 : x0, j ? y1 : y0, k ? z1 : z0];
  const quads = [
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)], [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)], [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
  ];
  return Float32Array.from(quads.flatMap(([a, b, c, d]) => [...a, ...b, ...c, ...a, ...c, ...d]));
}
const concat = (...arrs) => { const out = new Float32Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

test("switching a part off keeps the grid identical (variants run on the same cells)", () => {
  const parts = sample.sampleCar(true).map((p) => ({ ...p, id: p.name }));
  const wing = parts.findIndex((p) => /wing/i.test(p.name));
  assert.ok(wing >= 0);
  const settings = { ...types.DEFAULT_SETTINGS, quality: "fast", detail_ratio: 2 };
  const on = setup.prepareCase(parts, settings);
  const off = setup.prepareCase(parts.map((p, i) => (i === wing ? { ...p, active: false } : p)), settings);
  for (const a of ["x", "y", "z"]) assert.deepEqual(Array.from(off.grid[a].faces), Array.from(on.grid[a].faces), `${a} faces`);
  assert.equal(off.partNames.length, on.partNames.length - 1);
  assert.ok(on.detail.ratio > 1 && on.detail.zones.some((z) => /wing/i.test(z)), `wing refined: ${JSON.stringify(on.detail)}`);
  assert.ok(on.grid.hmin < 0.6 * on.grid.h, `detail cells ${on.grid.hmin} vs ${on.grid.h}`);
  // Per-part force ranges cover every wall entry exactly once.
  let n = 0;
  for (let p = 0; p < on.partNames.length; p++) n += on.partRanges[2 * p + 1] - on.partRanges[2 * p];
  assert.equal(n, on.faceCount);
});

test("overlapping shells in one part stay solid; wheels are never thin walls", () => {
  const g = grid.buildGrid({ domain: [-2, 3, -1.5, 1.5, 0, 2], low: [-0.5, -0.5, 0.1], high: [0.5, 0.5, 0.6], cellsPerLength: 40, levels: 1 });
  // Two overlapping boxes in one soup: parity would hollow out the overlap, the winding rule does not.
  const soup = concat(boxSoup(-0.5, 0.2, -0.3, 0.3, 0.1, 0.5), boxSoup(-0.2, 0.5, -0.3, 0.3, 0.1, 0.5));
  const v = vox.voxelize(g, [{ positions: soup }]);
  const cellVol = (i) => g.x.widths[i % g.x.n] * g.y.widths[Math.floor(i / g.x.n) % g.y.n] * g.z.widths[Math.floor(i / (g.x.n * g.y.n))];
  let solidVol = 0;
  for (let i = 0; i < g.cells; i++) if (v.solid[i]) solidVol += cellVol(i);
  const union = 1.0 * 0.6 * 0.4;
  assert.ok(Math.abs(solidVol - union) / union < 0.15, `solid ${solidVol} vs union ${union}`);
  // A thin disc marked as a wheel is not turned into a zero-thickness wall.
  const disc = boxSoup(-0.3, 0.3, -0.01, 0.01, 0.1, 0.4);
  const w = vox.voxelize(g, [{ positions: disc, role: "wheel" }, { positions: disc, role: "body" }]);
  assert.deepEqual(w.thinParts, [1]);
});

test("detail bands: finer cells inside the band, bounded growth, multigrid-friendly count", () => {
  const spec = { lo: -10, hi: 20, fineLo: -2, fineHi: 5, h: 0.05, growthLo: 1.15, growthHi: 1.08, hmax: 0.8 };
  const a = grid.buildAxis(spec, 16, undefined, [{ lo: 1, hi: 1.3, h: 0.0125 }]);
  assert.equal(a.n % 16, 0);
  const inBand = [...a.centers].map((c, i) => [c, a.widths[i]]).filter(([c]) => c > 1.02 && c < 1.28);
  for (const [, w] of inBand) assert.ok(w < 0.0135, `band width ${w}`);
  for (let i = 1; i < a.n; i++) {
    const r = a.widths[i] / a.widths[i - 1];
    assert.ok(r < 2.01 && r > 0.49, `ratio ${r}`);
  }
  const plain = grid.buildAxis(spec, 16);
  assert.deepEqual(Array.from(grid.buildAxis(spec, 16, undefined, []).faces), Array.from(plain.faces));
});

test("detail boxes refine a region inside a larger part", () => {
  const parts = sample.sampleCar(false).map((p) => ({ ...p, id: p.name }));
  const settings = { ...types.DEFAULT_SETTINGS, quality: "fast" };
  const plain = setup.prepareCase(parts, settings);
  assert.equal(plain.detail.ratio, 1);
  const box = { name: "Hood vent", x_min: -1.6, x_max: -1.0, y_min: -0.4, y_max: 0.4, z_min: 0.7, z_max: 1.0 };
  assert.throws(()=>setup.prepareCase(parts, { ...settings, detail_ratio: 3, detail_boxes: [box] }), /limited to 2.5 M/);
  const c = setup.prepareCase(parts, { ...settings, detail_ratio: 2, detail_boxes: [box] });
  assert.deepEqual(c.detail.zones, ["Hood vent"]);
  const i = grid.locate(c.grid.x, -1.3), j = grid.locate(c.grid.y, 0), k = grid.locate(c.grid.z, 0.85);
  for (const [a, n] of [[c.grid.x, i], [c.grid.y, j], [c.grid.z, k]]) assert.ok(a.widths[n] < 0.6 * c.grid.h, `width ${a.widths[n]} vs h ${c.grid.h}`);
});
