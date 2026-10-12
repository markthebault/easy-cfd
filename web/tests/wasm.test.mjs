import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

let server,prepare,results,types,sample,features;
before(async()=>{
  server=await createServer({server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  const caseModule=await server.ssrLoadModule("/src/engine/wasmCase.ts");prepare=caseModule.prepareWasmCase;
  results=await server.ssrLoadModule("/src/engine/wasmResults.ts");types=await server.ssrLoadModule("/src/solver/types.ts");
  sample=await server.ssrLoadModule("/src/geometry/sample.ts");features=await server.ssrLoadModule("/src/engine/features.ts");
});
after(()=>server?.close());

function cube(){return {id:"body",name:"Body",role:"body",positions:new Float32Array([-2,-1,.1,2,-1,.1,2,1,.1,-2,-1,.1,2,1,.1,-2,1,1.2])};}
const text=(c,path)=>new TextDecoder().decode(c.files[path]);

test("browser case preserves yaw, road speed, wheel rotation and dimensional pressure",()=>{
  const wheel={...cube(),id:"wheel",name:"Wheel",role:"wheel",wheel:{center:[-1,.8,.35],radius:.34}};
  const s={...types.DEFAULT_SETTINGS,speed_kmh:108,yaw_deg:10};
  const c=prepare([cube(),wheel],s),U=text(c,"0/U");
  assert.deepEqual(c.inlet,[30,30*Math.tan(Math.PI/18),0]);
  assert.ok(U.includes("value uniform (30 0 0)"));assert.ok(U.includes("omega -88.23529411764706"));
  assert.match(text(c,"0/p"),/dimensions \[0 2 -2 0 0 0 0\]/);
  assert.match(text(c,"constant/turbulenceProperties"),/RASModel kOmegaSST/);
  const fixed=prepare([cube(),wheel],{...s,moving_ground:false,wheels:false});
  assert.match(text(fixed,"0/U"),/ground \{type fixedValue; value uniform \(0 0 0\)/);
  assert.match(text(fixed,"0/U"),/part1 \{type noSlip;/);
  assert.deepEqual(fixed.inlet,c.inlet);
});

test("unsupported advanced and transient requests fail explicitly, disabled groups are excluded",()=>{
  assert.throws(()=>prepare([cube()],{...types.DEFAULT_SETTINGS,quality:"precise"}),/connected server/);
  assert.throws(()=>prepare([cube()],{...types.DEFAULT_SETTINGS,flow_animation:true}),/Recording physical-time/);
  const off={...cube(),id:"disabled",active:false};
  assert.equal(prepare([cube(),off],types.DEFAULT_SETTINGS).parts.length,1);
  assert.throws(()=>prepare([cube()],{...types.DEFAULT_SETTINGS,simulation_box:{x_min:0,x_max:1,y_min:0,y_max:1,z_max:1}}),/contain the whole car/);
});

test("OpenFOAM wall integrals retain signs, per-part forces, moments and the last-50 iteration window",()=>{
  const s={...types.DEFAULT_SETTINGS,axles:{frontX:-1,rearX:1,centrelineY:0,confirmed:true}};
  const c=prepare([cube()],s);
  // A late pressure change verifies that the average does not include startup iterations.
  const tsv=Array.from({length:70},(_,i)=>[i+1,i<20?50:100,0,-40,10,0,0,0,60,0,0,0,0].join("\t")).join("\n");
  const r=results.wasmResult(c,s,tsv,"",12,1000,"mesh");
  assert.equal(r.drag,110);assert.equal(r.lift,-40);assert.equal(r.downforce,40);
  assert.deepEqual(r.aero.force,[110,0,-40]);assert.deepEqual(r.aero.moment,[0,60,0]);
  assert.deepEqual(r.partForces[0].pressure,[100,0,-40]);
  assert.equal(r.balance.rearLift,-30);assert.equal(r.balance.frontLift,-10);
  assert.equal(r.openfoam.averagingIterations,50);assert.equal(r.provenance.averaging.start,21);
  assert.equal(r.engine,"openfoam");assert.equal(r.openfoam.runtime,"wasm");
  assert.throws(()=>results.wasmResult(c,s,"1 NaN","",0,100,"mesh"),/finite, complete/);
});

test("same 21-byte field format as the server, with invalid cells masked rather than invented",()=>{
  const c=prepare([cube()],types.DEFAULT_SETTINGS),n=c.viz.dims.reduce((a,b)=>a*b,1),buffer=new ArrayBuffer(21*n);
  new Float32Array(buffer,0,n).fill(12);new Float32Array(buffer,12*n,n).fill(3);
  new Uint8Array(buffer,20*n,n).fill(1);new Uint8Array(buffer,20*n,n)[2]=0;
  const f=results.wasmField(c,new Uint8Array(buffer));
  assert.equal(f.u[0],12);assert.equal(f.p[0],3);assert.equal(f.solid[2],1);assert.equal(f.solid[0],0);
  assert.deepEqual(f.origin,c.viz.origin);assert.deepEqual(f.dims,c.viz.dims);
  assert.throws(()=>results.wasmField(c,new Uint8Array(1)),/invalid flow field/);
});

test("legacy WebGPU and offline advanced designs migrate to runnable, bounded browser presets",()=>{
  const s=features.availableSettings({...types.DEFAULT_SETTINGS,engine:"webgpu",quality:"custom",flow_animation:true,max_seconds:9999});
  assert.equal(s.engine,"wasm");assert.equal(s.quality,"fast");assert.equal(s.flow_animation,false);assert.equal(s.max_seconds,300);
  assert.equal(features.engineLabel({engine:"openfoam",openfoam:{runtime:"wasm"}}),"OpenFOAM · Browser");
});
