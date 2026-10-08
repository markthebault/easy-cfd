import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forceModel, wingModel, diffuserModel, balanceModel, gciModel, yawModel, frontier } from '../course/models.mjs';
const near=(actual,expected,tol=1e-8)=>assert.ok(Math.abs(actual-expected)<tol,`${actual} != ${expected}`);
test('Course preserves signed lift, quadratic forces, cubic still-air power, and area convention',()=>{
  const a=forceModel({speed:100,density:1.225,area:2.2,cd:.32,cl:-.4}),b=forceModel({speed:200,density:1.225,area:2.2,cd:.32,cl:-.4});
  near(a.q,472.608024691358);near(a.drag,332.716049382716);near(a.downforce,415.895061728395);near(b.drag,4*a.drag);near(b.power,8*a.power);
  assert.ok(forceModel({cl:.1}).downforce<0);
  const differentArea=forceModel({area:2.2,cd:.32*2/2.2});near(differentArea.drag,forceModel({area:2,cd:.32}).drag);
});
test('Wing model uses local dynamic pressure, wing area, finite span, and a visible extrapolation flag',()=>{
  const a=wingModel({angle:6,localRatio:1}),b=wingModel({angle:6,localRatio:.8});near(b.downforce,.64*a.downforce);near(a.area,1.7*.32);assert.equal(wingModel({angle:18}).extrapolated,true);near(wingModel({angle:-2}).downforce,0);
});
test('Diffuser model is ideal recovery, not a force or stall model',()=>{
  const flat=diffuserModel({angle:0}),r=diffuserModel({height:.1,length:.8,angle:7});near(flat.ratio,1);near(flat.recovery,0);near(r.exit,.1+.8*Math.tan(7*Math.PI/180));assert.ok(r.recovery>550&&r.recovery<565);assert.equal('downforce' in r,false);
});
test('Axle loads conserve force and moment, including front unloading and zero-load undefined balance',()=>{
  const r=balanceModel({wheelbase:2.6,frontLoad:150,frontPosition:-.4,rearLoad:500,rearPosition:3});near(r.moment,1440);near(r.rear,1440/2.6);near(r.front+r.rear,650);assert.ok(balanceModel({frontLoad:0}).front<0);assert.equal(balanceModel({frontLoad:0,rearLoad:0}).frontFraction,null);
});
test('GCI computes the worked sequence and rejects oscillating, zero, and divergent data',()=>{
  const r=gciModel({});assert.equal(r.valid,true);near(r.order,2);near(r.extrapolated,.2952);near(r.gci,.02);
  for(const values of [{fine:0},{medium:.3},{fine:.30,medium:.32,coarse:.31},{fine:.3,medium:.32,coarse:.33},{ratio:1}])assert.equal(gciModel(values).valid,false);
});
test('Wind triangle separates road motion and relative airspeed, including yaw sign',()=>{
  const r=yawModel({roadSpeed:120,headwind:0,crosswind:6});near(r.road,120/3.6);near(r.airspeed,Math.hypot(120/3.6,6));near(r.yaw,Math.atan2(6,120/3.6)*180/Math.PI);near(yawModel({crosswind:-5}).yaw,-yawModel({crosswind:5}).yaw);
});
test('Pareto frontier applies dominance to feasible candidates without a hidden score',()=>{
  const a={drag:2,load:5},b={drag:3,load:4},c={drag:4,load:8};assert.deepEqual(frontier([a,b,c]),[a,c]);
});
test('Retained CFD evidence is complete, finite, consistently normalised, and on one common grid',()=>{
  const e=JSON.parse(readFileSync(new URL('../course/evidence/runs.json',import.meta.url),'utf8'));assert.equal(e.cases.length,9);
  const grids=new Set();for(const c of e.cases){assert.ok(c.result);const r=c.result;assert.ok(Number.isFinite(r.cd)&&Number.isFinite(r.cl));assert.ok(r.history.length>10);near(r.drag,r.cd*r.dynamicPressure*e.settings.reference_area,1e-4);near(r.downforce,-r.lift,1e-8);grids.add(r.gridId);assert.equal(r.cells,1474560);}
  assert.equal(grids.size,1);
});
test('Course geometry manifest identifies the exact closed inputs in both evidence captures',()=>{
  const read=name=>JSON.parse(readFileSync(new URL('../course/evidence/'+name,import.meta.url),'utf8'));
  const manifest=read('geometry-manifest.json'),runs=read('runs.json'),viewer=read('viewer-run.json');
  assert.equal(manifest.files.length,12);assert.equal(manifest.files.filter(f=>f.base).length,5);
  for(const file of manifest.files){
    assert.equal(file.closedMesh,true);assert.ok(file.signedVolume_m3>0);assert.match(file.sha256,/^[0-9a-f]{64}$/);
    assert.equal(viewer.source.files.find(f=>f.name===file.file)?.hash,file.sha256);
    assert.equal(runs.geometryFiles.find(f=>f.file===file.file)?.sha256,file.sha256);
  }
});
