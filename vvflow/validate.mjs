import create from '../web/public/vvflow/vvflow.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const m=await create();
const cases=[{name:'mx5-short',args:[3,240,20,40000,.005,0],tolerance:1e-7},{name:'cylinder-short',args:[0,80,10,100,.02,0],tolerance:1e-7},{name:'cylinder-transient',args:[0,80,100,100,.02,0],tolerance:.001},{name:'airfoil-transient',args:[1,120,100,2000,.01,5],tolerance:.005},{name:'spoiler-short',args:[2,120,20,2000,.01,5],tolerance:1e-7},{name:'spoiler-moving',args:[2,120,800,2000,.01,5],tolerance:.02,characterization:true}];
const results=[];
for(const {name,args,tolerance,characterization}of cases){
 const [shape,panels,steps,re,dt,angle]=args;
 const native=JSON.parse(execFileSync('docker',['run','--rm','-v',`${root}:/src`,'easycfd-vvflow-native:local','/src/vvflow/build/native/vvflow',...args.map(String)],{maxBuffer:40e6,encoding:'utf8'}));
 assert.equal(m._vv_init(shape,panels,re,dt,angle),0,m.UTF8ToString(m._vv_error()));
 const start=performance.now();for(let i=0;i<steps;i++)assert.equal(m._vv_step(1),0,m.UTF8ToString(m._vv_error()));
 const elapsedMs=performance.now()-start, stats=Array.from(m.HEAPF64.subarray(m._vv_stats()/8,m._vv_stats()/8+10));
 assert.ok(stats.every(Number.isFinite));assert.equal(stats[0],native.stats[0]);assert.equal(stats[5],steps);
 const forceError=Math.max(...[1,2,3].map(i=>Math.abs(stats[i]-native.stats[i])));
 const vortexCountError=Math.abs(stats[4]-native.stats[4]);
 const result={name,args,nativeStats:native.stats,wasmStats:stats,forceError,tolerance,vortexCountError,elapsedMs,acceptance:!characterization,withinTolerance:forceError<tolerance};results.push(result);console.log(name,JSON.stringify(result));
 // Tolerances test the short-time port; they are not physical-accuracy bounds.
 if(!characterization)assert.ok(forceError<tolerance,`${name}: force difference ${forceError} exceeds ${tolerance}`);
 if(shape===2 && steps===800)assert.ok(Math.abs(stats[6]-Math.PI/3)<.001);
 if(steps===10)assert.equal(vortexCountError,0);
 m._vv_dispose();
}
assert.equal(m._vv_init(0,0,100,.02,0),-1);assert.match(m.UTF8ToString(m._vv_error()),/Invalid/);
assert.equal(m._vv_step(1),-1);
assert.equal(m._vv_init(0,80,100,.02,0),0);assert.equal(m._vv_step(1),0);
const again=Array.from(m.HEAPF64.subarray(m._vv_stats()/8,m._vv_stats()/8+10));m._vv_dispose();assert.equal(m._vv_init(0,80,100,.02,0),0);assert.equal(m._vv_step(1),0);
assert.deepEqual(Array.from(m.HEAPF64.subarray(m._vv_stats()/8,m._vv_stats()/8+10)),again);m._vv_dispose();
writeFileSync(resolve(root,'vvflow/validation.json'),JSON.stringify({upstream:'f6419b3a9f69cee1eaf2655154439cb69dd0fea6',note:'Native adapter with system BLAS/LAPACK versus WASM adapter with CLAPACK; not physical validation or comparison with the original CLI.',results},null,2)+'\n');
