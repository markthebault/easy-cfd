import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "vite";
let server,boundary,lattice,metrics,grids,scene,geometry,BrowserLBM;
before(async()=>{server=await createServer({server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  boundary=await server.ssrLoadModule('/src/flow2d/boundary.ts');lattice=await server.ssrLoadModule('/src/flow2d/lattice.ts');metrics=await server.ssrLoadModule('/src/flow2d/metrics.ts');grids=await server.ssrLoadModule('/src/flow2d/grid.ts');scene=await server.ssrLoadModule('/src/flow2d/scene.ts');geometry=await server.ssrLoadModule('/src/flow2d/geometry.ts');({BrowserLBM}=await server.ssrLoadModule('/src/flow2d/lbm.ts'));await BrowserLBM.backend(true);});
after(()=>server?.close());
test('closed solid boundary has zero net force under uniform pressure',()=>{
  const nx=48,ny=32,n=nx*ny,mask=new Float32Array(n);for(let y=10;y<20;y++)for(let x=14;x<28;x++)mask[y*nx+x]=1;
  const links=boundary.forceLinks(nx,ny,mask);let x=0,y=0;
  for(let i=0;i<links.indices.length;i++){const f=lattice.WEIGHTS[Math.floor(links.indices[i]/n)];x+=f*links.x[i];y+=f*links.y[i];}
  assert.ok(Math.abs(x)<1e-12&&Math.abs(y)<1e-12);
});
test('cumulative force means discard startup, weight solver steps and require repeated stability checks',()=>{
  const grid=grids.LEGACY_GRID,ref=.4,monitor=new metrics.ForceMonitor(grid,ref,'wasm',true,'one');
  const factor=2*grids.cellSize(grid)/(lattice.INLET**2*ref),block=monitor.blockSteps,warmup=monitor.warmupSteps;
  let steps=warmup;
  const sample=(count,cd=.5,cl=-.2)=>{steps+=count;return monitor.push({x:cd/factor*count,y:cl/factor*count,steps:count},steps);};
  assert.equal(monitor.push({x:999,y:999,steps:warmup},warmup).cd,null);
  assert.ok(warmup>=grid.width/(lattice.INLET*grids.cellSize(grid)));
  assert.equal(sample(block).status,'sampling');
  let report;for(let i=1;i<10;i++)report=sample(block);
  assert.equal(report.status,'settling');assert.equal(report.stableChecks,1);
  report=sample(block);assert.equal(report.status,'settling');report=sample(block);assert.equal(report.status,'ready');
  assert.ok(Math.abs(report.cd-.5)<1e-12);assert.ok(Math.abs(report.cl+.2)<1e-12);assert.ok(report.cdVariation<1e-7);assert.equal(report.sampledSteps,12*block);
  const other=new metrics.ForceMonitor(grid,ref,'wasm',true);other.push({x:0,y:0,steps:warmup},warmup);
  const all=other.push({x:.5/factor*12*block,y:-.2/factor*12*block,steps:12*block},warmup+12*block);
  assert.ok(Math.abs(all.cd-report.cd)<1e-12);assert.ok(Math.abs(all.cl-report.cl)<1e-12);assert.equal(all.status,'ready');
  assert.notEqual(report.key,metrics.forceConditions(grid,ref*2,'wasm'));assert.notEqual(report.key,metrics.forceConditions(grid,ref,'webgpu'));
  // A new drift must revoke readiness; a full averaging interval alone is insufficient.
  report=sample(block,1.5,.8);assert.equal(report.status,'settling');assert.equal(report.stableChecks,0);
  assert.equal(monitor.batchSize(128,warmup-3),3);
  const empty=new metrics.ForceMonitor(grid,ref,'wasm',false).push({x:0,y:0,steps:8},8);assert.equal(empty.status,'empty');assert.equal(empty.cd,0);assert.equal(empty.cl,0);
});
test('observed car wakes have quieter cumulative means without falsely passing the drift check',async()=>{
  const runs=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/flow2d-car-force-history.json',import.meta.url),'utf8'));
  for(const run of runs){const monitor=new metrics.ForceMonitor(run.grid,run.reference,'webgpu',true),factor=2*grids.cellSize(run.grid)/(lattice.INLET**2*run.reference),old=[],out=[];let count=0,last;
    for(const s of run.samples){last=monitor.push({x:s.cd*1024/factor,y:s.cl*1024/factor,steps:1024},s.steps);old.push({steps:1024,cd:s.cd,cl:s.cl});count+=1024;
      const limit=2*run.reference/(lattice.INLET*grids.cellSize(run.grid));while(count>limit){const take=Math.min(old[0].steps,count-limit);old[0].steps-=take;count-=take;if(!old[0].steps)old.shift();}
      if(s.travel>=20)out.push({cd:last.cd,cl:last.cl,oldCd:old.reduce((a,b)=>a+b.steps*b.cd,0)/count,oldCl:old.reduce((a,b)=>a+b.steps*b.cl,0)/count});
    }
    const deviation=key=>{const mean=out.reduce((a,b)=>a+b[key],0)/out.length;return Math.sqrt(out.reduce((a,b)=>a+(b[key]-mean)**2,0)/out.length);};
    assert.ok(deviation('cd')<deviation('oldCd')*.25,run.name+' drag mean');assert.ok(deviation('cl')<deviation('oldCl')*.25,run.name+' lift mean');
    assert.equal(last.status,'settling');assert.ok(last.cdDrift>last.cdTolerance||last.clDrift>last.clTolerance);
  }
});
test('names and disabled geometry are metadata; active angle changes restart the physics',()=>{
  const a=scene.shapeFrom(geometry.PRESETS.airfoil),b={...scene.moveShape(a,.1,.3),id:'b',enabled:false};const s={shapes:[a,b],selectedId:a.id,tunnel:'small',referenceLength:1.45};
  assert.equal(scene.simulationKey(s),scene.simulationKey({...s,shapes:[{...a,name:'Wing'},scene.moveShape(b,10,10)]}));
  assert.notEqual(scene.simulationKey(s),scene.simulationKey({...s,shapes:[scene.rotateShape(a,5),b]}));
  assert.notEqual(scene.simulationKey(s),scene.simulationKey({...s,shapes:[a,{...b,enabled:true}]}));
  assert.equal(scene.referenceLengthFor({...s,shapes:[scene.rotateShape(a,20),b]}),1.45);assert.equal(scene.sceneError({...s,shapes:[a,scene.moveShape(b,10,10)]}),null);
});
test('portable empty tunnel has exactly zero accumulated obstacle force',async()=>{
  const solver=new BrowserLBM(48,24,new Float32Array(48*24));try{solver.advance(32);const f=await solver.forces();assert.deepEqual(f,{x:0,y:0,steps:32});solver.advance(8);const again=await solver.forces();assert.deepEqual(again,{x:0,y:0,steps:8});}finally{solver.dispose();}
});
test('saved configurations retain geometry, fixed values and provisional status across storage',async()=>{
  const {persistConfigurations,restoreConfigurations,CONFIGURATION_KEY}=await server.ssrLoadModule('/src/flow2d/configurations.ts'),savedStorage=globalThis.localStorage,values=new Map();
  try{
    globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
    const design=scene.sceneFrom(geometry.PRESETS['inverted-airfoil']),grid=grids.TUNNELS.small,reference=.5,m=new metrics.ForceMonitor(grid,reference,'webgpu',true,'saved');
    m.push({x:0,y:0,steps:m.warmupSteps},m.warmupSteps);
    const provisional=m.push({x:1,y:-2,steps:m.blockSteps},m.warmupSteps+m.blockSteps),record={id:'one',name:'Rear wing',savedAt:'2026-11-04T00:00:00Z',scene:design,report:provisional};
    persistConfigurations([record]);design.shapes[0].name='Changed live name';
    const restored=restoreConfigurations();assert.equal(restored.length,1);assert.equal(restored[0].scene.shapes[0].name,'Inverted airfoil');assert.equal(restored[0].report.status,'sampling');assert.equal(restored[0].report.cd,provisional.cd);
    values.set(CONFIGURATION_KEY,JSON.stringify([null,{...record,report:{cd:null}},...restored]));assert.equal(restoreConfigurations().length,1);
  }finally{if(savedStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=savedStorage;}
});
