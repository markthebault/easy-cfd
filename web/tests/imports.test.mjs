import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
let server, model;
before(async () => {
  server = await createServer({root:resolve(dirname(fileURLToPath(import.meta.url)),".."),server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  model = await server.ssrLoadModule("/src/geometry/model.ts");
});
after(async () => server?.close());

test("OBJ decorative lines and points do not hide an object's surface faces", async () => {
  const text = "o body\nv 0 0 0\nv 4 0 0\nv 0 2 1\nf 1 2 3\nl 1 2\np 3\no mirror\nf 1 3 2\nl 1 3\n";
  const raw = await model.readFile({name:"car.obj",bytes:new TextEncoder().encode(text).buffer,base:true});
  assert.equal(raw.length,2);
  assert.deepEqual(raw.map(p=>p.name),["body","mirror"]);
  assert.equal(raw.reduce((n,p)=>n+p.positions.length/9,0),2);
});

test("CAD metres remain unchanged when mesh file units change in a mixed assembly", () => {
  const tri=new Float32Array([0,0,0,4,0,0,0,2,1]);
  const raw=[{name:"CAD",file:"body.step",positions:tri,units:"m",base:true},{name:"mesh",file:"wing.stl",positions:tri.map(v=>v*1000),base:false}];
  const parts=model.buildParts(raw,{...model.DEFAULT_IMPORT,units:"mm",split:false});
  assert.deepEqual(parts[0].positions,parts[1].positions);
  assert.equal(model.soupBounds([parts[0].positions]).high[0]-model.soupBounds([parts[0].positions]).low[0],4);
});

test("initial import suggests the long axis and up axis and recognizes millimetre meshes", () => {
  const positions=new Float32Array([0,0,0,2000,1200,4500,0,1200,0]);
  assert.deepEqual(model.suggestImport([{name:"car",file:"car.stl",positions}]),{...model.DEFAULT_IMPORT,forward:"-Z",up:"+Y",units:"mm"});
});
