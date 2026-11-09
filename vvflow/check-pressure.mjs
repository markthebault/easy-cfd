import create from '../web/public/vvflow/vvflow.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const m=await create(), root=resolve(import.meta.dirname,'..');
function state(){return {stats:Array.from(m.HEAPF64.subarray(m._vv_stats()/8,m._vv_stats()/8+10)),particles:Array.from(m.HEAPF64.subarray(m._vv_particles()/8,m._vv_particles()/8+4*m._vv_count())),bodies:Array.from(m.HEAPF64.subarray(m._vv_bodies()/8,m._vv_bodies()/8+3*m._vv_body_count()))};}
function init(density=1,shape=3,steps=20){assert.equal(m._vv_init(shape,240,40000,.005,0),0);assert.equal(m._vv_density(density),0);for(let i=0;i<steps;i++)assert.equal(m._vv_step(1),0,m.UTF8ToString(m._vv_error()));}
const results=[];
for(const shape of [0,2,3]){
 init(2,shape);const before=state();
 const start=performance.now();assert.equal(m._vv_pressure(-.4,-.4,.04,64,32),0,m.UTF8ToString(m._vv_error()));
 const pressure=Array.from(m.HEAPF64.subarray(m._vv_pressure_data()/8,m._vv_pressure_data()/8+64*32));
 assert.deepEqual(state(),before,'Pressure evaluation must not mutate the live solver');
 assert.ok(pressure.filter(Number.isFinite).length>1400);
 assert.ok(pressure.some(v=>v>0)&&pressure.some(v=>v<0));
 const native=JSON.parse(execFileSync('docker',['run','--rm','-v',`${root}:/src`,'easycfd-vvflow-native:local','/src/vvflow/build/native/vvflow',String(shape),'240','20','40000','.005','0','2','1'],{encoding:'utf8',maxBuffer:20e6}));
 let error=0,finite=0;for(let i=0;i<pressure.length;i++){assert.equal(Number.isFinite(pressure[i]),native.pressure[i]!==null);if(Number.isFinite(pressure[i])){error=Math.max(error,Math.abs(pressure[i]-native.pressure[i]));finite++;}}
 assert.ok(error<.002,`Native/WASM pressure mismatch: ${error}`);
 assert.equal(m._vv_step(1),0);const withPressure=state();init(2,shape,21);assert.deepEqual(state(),withPressure,'Pressure must not affect the next step');
 results.push({shape,nativeMaxAbsoluteCpError:error,finiteCells:finite,liveStateUnchanged:true,nextStepUnchanged:true,elapsedMs:performance.now()-start});
 console.log('pressure',results.at(-1));
}
const density=[];
for(const level of [1,2,4]){const start=performance.now();init(level,3,500);const s=state();assert.ok(s.stats.every(Number.isFinite));density.push({level,vortices:m._vv_count(),elapsedMs:performance.now()-start});}
assert.ok(density[1].vortices>density[0].vortices*1.5);assert.ok(density[2].vortices>density[1].vortices*1.5);
assert.equal(m._vv_density(3),-1);assert.equal(m._vv_pressure(0,0,0,1,1),-1);
console.log('density',density);
writeFileSync('vvflow/pressure-validation.json',JSON.stringify({note:'Numerical port and state-isolation checks, not physical validation. Cp compared with native adapter using upstream XPressure.',results,density},null,2)+'\n');
