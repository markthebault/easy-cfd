import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
let server, geometry, scene, grids, render, vortices;
before(async()=>{server=await createServer({server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  geometry=await server.ssrLoadModule("/src/flow2d/geometry.ts");scene=await server.ssrLoadModule("/src/flow2d/scene.ts");grids=await server.ssrLoadModule("/src/flow2d/grid.ts");render=await server.ssrLoadModule("/src/flow2d/render.ts");vortices=await server.ssrLoadModule("/src/flow2d/vortices.ts");});
after(()=>server?.close());
test("physical tunnel dimensions use square cells and full-size car geometry",()=>{
  const sizes={small:[3,2],medium:[7,3],large:[20,7]};
  for(const [id,[width,height]] of Object.entries(sizes)){const grid=grids.TUNNELS[id];assert.equal(grid.width,width);assert.equal(grid.height,height);assert.ok(Math.abs(width/(grid.nx-1)-height/(grid.ny-1))<1e-12);}
  const car=scene.bounds(geometry.PRESETS.car.points);assert.ok(Math.abs(car.width-4.3)<1e-10);assert.ok(Math.abs(car.height-1.5)<1e-10);assert.ok(Math.abs(car.minY-.15)<1e-10);
  assert.equal(scene.sceneError(scene.sceneFrom(geometry.PRESETS.car)),null);
  assert.match(scene.sceneError(scene.sceneFrom(geometry.PRESETS.car,"small")),/larger box/);
  const added=scene.addedPreset("car",undefined,grids.TUNNELS.large);assert.ok(Math.abs(scene.bounds(added.points).width-4.3)<1e-10);
});
test("zoom/pan, masks and velocity gradients use each box's physical scale",()=>{
  for(const id of ["small","medium","large"]){const grid=grids.TUNNELS[id], camera={zoom:1.7,pan:{x:45,y:-20}},v=render.viewport(1440,900,camera,grid),p={x:grid.width*.35,y:grid.height*.4};
    const q=render.worldPoint(render.screenPoint(p,v),v);assert.ok(Math.hypot(q.x-p.x,q.y-p.y)<1e-10);
    const before=render.screenPoint(p,v),next=render.zoomCamera(camera,2.1,1440,900,before,grid),after=render.screenPoint(p,render.viewport(1440,900,next,grid));assert.ok(Math.hypot(after.x-before.x,after.y-before.y)<1e-8);
    const mask=geometry.maskFor(geometry.PRESETS.airfoil.points,grid.nx,grid.ny,grid);assert.equal(mask.length,grid.nx*grid.ny);assert.ok(mask.reduce((a,b)=>a+b,0)>30);
    const n=grid.nx*grid.ny,field=new Float32Array(3*n);for(let y=0;y<grid.ny;y++)for(let x=0;x<grid.nx;x++){field[y*grid.nx+x]=-2*y*grid.height/(grid.ny-1);field[n+y*grid.nx+x]=2*x*grid.width/(grid.nx-1);}
    const cores=vortices.vortexCores(field,new Float32Array(n),grid);assert.ok(Math.abs(cores[Math.floor(grid.ny/2)*grid.nx+Math.floor(grid.nx/2)]-2)<.0001);
  }
});
test("old saved projects gain room without rescaling their authored geometry",()=>{
  const old={shapes:[{...geometry.CAR_REFERENCE,id:"old",rotation:0}],selectedId:"old"};
  const oldLocation=globalThis.location,oldStorage=globalThis.localStorage;
  try{globalThis.location={search:""};globalThis.localStorage={getItem:key=>key==="easycfd.flow2d.v2"?JSON.stringify(old):null};const migrated=scene.restoreScene();assert.equal(migrated.tunnel,"medium");assert.deepEqual(migrated.shapes,old.shapes);}
  finally{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;}
});
