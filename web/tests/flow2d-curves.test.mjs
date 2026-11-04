import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
let server, curves, scene, geometry;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  curves = await server.ssrLoadModule("/src/flow2d/curves.ts");
  scene = await server.ssrLoadModule("/src/flow2d/scene.ts");
  geometry = await server.ssrLoadModule("/src/flow2d/geometry.ts");
});
after(() => server?.close());
test("cubic ellipse sampling retains anchors, area and a resolved solid", () => {
  const nodes = curves.ellipse({ x: 1, y: .5 }, { x: 1.8, y: .9 }), points = curves.sampleCurve(nodes);
  assert.equal(nodes.length, 4); assert.ok(points.length > 12 && points.length <= 512);
  assert.ok(Math.abs(Math.abs(geometry.signedArea(points)) / (Math.PI * .4 * .2) - 1) < .01);
  assert.equal(geometry.validProfile(points), true);
  assert.ok(geometry.maskFor(points).reduce((a, b) => a + b) > 100);
  assert.match(curves.curvePath(nodes), /C.*Z$/);
  assert.equal(curves.validCurve([{x:0,y:0,incoming:{x:NaN,y:0}},{x:1,y:0},{x:1,y:1}]), false);
});
test("group transforms preserve curve handles and resize all solids about a shared pivot", () => {
  const curve = curves.ellipse({ x: 1, y: .5 }, { x: 1.8, y: .9 });
  const a = { id: "a", name: "ellipse", rotation: 0, curve, points: curves.sampleCurve(curve) };
  const b = { ...geometry.CAR_REFERENCE, id: "b", rotation: 0 };
  const group = { shapes: [a, b], selectedId: "a", selectedIds: ["a", "b"] };
  const moved = scene.transformSelection(group, s => scene.moveShape(s, .1, .1));
  assert.ok(Math.abs(moved.shapes[0].curve[0].outgoing.x - curve[0].outgoing.x - .1) < 1e-10);
  assert.ok(Math.abs(moved.shapes[1].points[0].y - b.points[0].y - .1) < 1e-10);
  const pivot = scene.bounds(moved.shapes.flatMap(s => s.points)).center;
  const scaled = scene.transformSelection(moved, s => scene.scaleShape(s, .8, .7, pivot));
  const boundsA = scene.bounds(moved.shapes.flatMap(s => s.points)), boundsB = scene.bounds(scaled.shapes.flatMap(s => s.points));
  assert.ok(Math.abs(boundsB.width / boundsA.width - .8) < .002);
  assert.ok(Math.abs(boundsB.height / boundsA.height - .7) < .002);
  assert.equal(scene.sceneError(scaled), null);
  const rotated = scene.rotateShape(a, 90, { x: 1.4, y: .7 });
  assert.ok(Math.abs(rotated.curve[0].y - 1.1) < 1e-10);
  assert.ok(curves.validCurve(rotated.curve));
});
test("the higher grid has four times the cells and freehand reduction keeps its corners", () => {
  assert.equal(geometry.NX * geometry.NY, 4 * 336 * 96);
  const reduced = curves.simplify([{x:0,y:0},{x:.5,y:.001},{x:1,y:0},{x:1,y:1},{x:0,y:1}], .01);
  assert.deepEqual(reduced, [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]);
});
test("box selection handles containment, crossed edges, reverse dragging and additive selection", () => {
  const shape = (id, points) => ({id, name:id, rotation:0, points});
  const a = shape("a",[{x:0,y:0},{x:2,y:0},{x:0,y:2}]);
  const b = shape("b",[{x:3,y:0},{x:5,y:0},{x:5,y:2},{x:3,y:2}]);
  const current = {shapes:[a,b],selectedId:"a",selectedIds:["a"]};
  assert.deepEqual(scene.selectInBox(current,{x:1.5,y:1.5},{x:1.7,y:1.7}).selectedIds,[],"bounding-box overlap alone must not select an empty corner");
  assert.deepEqual(scene.selectInBox(current,{x:3.5,y:.5},{x:4,y:1}).selectedIds,["b"],"selection wholly inside a solid");
  assert.deepEqual(scene.selectInBox(current,{x:4,y:1},{x:3.5,y:.5},true).selectedIds,["a","b"]);
  const bar=shape("bar",[{x:0,y:1.4},{x:3,y:1.4},{x:3,y:1.6},{x:0,y:1.6}]);
  assert.deepEqual(scene.selectInBox({shapes:[bar],selectedId:null},{x:1.4,y:0},{x:1.6,y:3}).selectedIds,["bar"],"crossed edges without contained vertices");
  assert.equal(scene.selectInBox(current,{x:3,y:0},{x:5,y:2}).shapes,current.shapes,"selection never mutates geometry");
});
