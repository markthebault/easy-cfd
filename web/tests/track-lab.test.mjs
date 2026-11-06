import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server, TrackPath, trackPoints;
before(async () => {
  server = await createServer({ root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error', appType: 'custom' });
  ({ TrackPath } = await server.ssrLoadModule('/src/track/trackPath.ts'));
  ({ trackPoints } = await server.ssrLoadModule('/src/track/physics.ts'));
});
after(async () => server?.close());

for (const circuit of ['barcelona', 'monza', 'zandvoort']) test(`${circuit}: heading is continuous through sample boundaries and the closed-lap seam`, async () => {
  const points = trackPoints(JSON.parse(await readFile(resolve(root, `public/tracks/${circuit}.geojson`), 'utf8')));
  const path = new TrackPath(points), epsilon = .00001;
  let maxStep = 0;
  for (const d of path.distances) {
    const a = path.pose(d - epsilon, 2.33, .0058), b = path.pose(d + epsilon, 2.33, .0058);
    assert.ok(a.position.distanceTo(b.position) < .0001, 'position jumps at a sample');
    maxStep = Math.max(maxStep, a.quaternion.angleTo(b.quaternion));
    assert.ok(Math.abs(a.forward.length() - 1) < 1e-8);
    assert.ok(Math.abs(a.forward.dot(a.up)) < 1e-8);
  }
  assert.ok(maxStep < .0001, `heading jumps ${maxStep} radians at a sample boundary`);
  const last = points.at(-1).distanceTo(points[0]);
  assert.ok(last < 6, `elevation discontinuity at finish: ${last} m`);
});

test('CFD bundle retains exact float32 data and contains a full-size field with matching wall samples', async () => {
  const folder = resolve(root, 'public/track-cfd');
  const m = JSON.parse(await readFile(resolve(folder, 'manifest.json'), 'utf8'));
  assert.equal(m.engine, 'openfoam');
  assert.ok(m.field.dims.reduce((a,b) => a*b, 1) > 850000);
  const buffers = {};
  for (const [name, hash] of Object.entries(m.hashes)) {
    const raw = gunzipSync(await readFile(resolve(folder, name + '.gz')));
    assert.equal(createHash('sha256').update(raw).digest('hex'), hash);
    buffers[name] = raw;
  }
  const n = m.field.dims.reduce((a,b) => a*b, 1);
  assert.equal(buffers['field.bin'].length, 21*n);
  for (const p of m.parts) {
    assert.equal(buffers[p.positions.slice(0,-3)].length, 12*p.vertices);
    assert.equal(buffers[p.cp.slice(0,-3)].length, 4*p.vertices);
  }
  // Keep the original numerical limitations attached to this reference; never call it converged.
  assert.equal(m.result.forceSettled, false);
  assert.equal(m.result.residualConverged, false);
  assert.equal(m.settings.speed_kmh, 144);
  assert.equal(m.settings.yaw_deg, 3);
});

test('speed/yaw map selects exact cases and interpolates a complete rectangle without extrapolation', async () => {
  const { mapWeights } = await server.ssrLoadModule('/src/track/aeroMap.ts');
  const map = { speeds: [40, 240], yaws: [-10, 0, 10], samples: [40, 240].flatMap(speedKmh => [-10, 0, 10].map(yawDeg => ({ speedKmh, yawDeg }))) };
  for (const speed of map.speeds) for (const yaw of map.yaws) {
    const a = mapWeights(map, speed, yaw);
    assert.equal(a.covered, true);
    assert.ok(Math.abs(a.weights.reduce((a,b) => a+b,0) - 1) < 1e-12);
    assert.equal(a.indices.reduce((v,i,j) => v + a.weights[j] * map.samples[i].speedKmh,0), speed);
    assert.equal(a.indices.reduce((v,i,j) => v + a.weights[j] * map.samples[i].yawDeg,0), yaw);
  }
  const mid = mapWeights(map, 140, 5);
  assert.deepEqual(mid.weights, [.25,.25,.25,.25]);
  const low = mapWeights(map, 10, -20);
  assert.equal(low.covered, false); assert.equal(low.speedKmh,40); assert.equal(low.yawDeg,-10);
  assert.equal(mapWeights(map, 300, 20).covered,false);
  const broken = { ...map, samples: map.samples.slice(1) };
  assert.throws(() => mapWeights(broken,80,-5), /missing a solved/);
});

test('airflow yaw comes from sideslip and wind, not absolute heading', async () => {
  const { airConditions } = await server.ssrLoadModule('/src/track/aeroMap.ts');
  for (let heading = 0; heading < Math.PI*2; heading += .2) {
    const f = { x:-Math.sin(heading), z:-Math.cos(heading) };
    const straight = airConditions(30,f,0,1.165,{speed:0,bearing:0});
    assert.ok(Math.abs(straight.yawDeg)<1e-10);
    assert.ok(Math.abs(straight.speedKmh-108)<1e-10);
    const corner = airConditions(30,f,.04,1.165,{speed:0,bearing:0});
    assert.ok(Math.abs(corner.yawDeg-Math.atan(1.165*.04)*180/Math.PI)<1e-10);
    const other = airConditions(30,f,-.04,1.165,{speed:0,bearing:0});
    assert.ok(Math.abs(other.yawDeg+corner.yawDeg)<1e-10);
  }
  const north={x:0,z:-1};
  assert.ok(airConditions(30,north,0,1.165,{speed:3,bearing:90}).yawDeg>0);
  assert.ok(airConditions(30,north,0,1.165,{speed:3,bearing:270}).yawDeg<0);
});

test('CFD loads interpolate Cl, respect force direction and scale with full relative airspeed squared', async () => {
  const { mapWeights, mapLoads } = await server.ssrLoadModule('/src/track/aeroMap.ts');
  const map = { speeds: [40,240], yaws: [-10,0,10], samples: [40,240].flatMap(speedKmh => [-10,0,10].map(yawDeg => ({
    speedKmh, yawDeg, forceSettled: true, residualConverged: true,
    loads: { cl: .2, cd: .3, density: 1.225, referenceArea: 2.2 },
  }))) };
  const load = (speed,yaw=0) => mapLoads(map,mapWeights(map,speed,yaw));
  const slow=load(80), fast=load(160), yawed=load(80,10);
  assert.ok(Math.abs(slow.liftN-.5*1.225*2.2*(80/3.6)**2*.2)<1e-10);
  assert.equal(slow.downforceN,0);
  assert.ok(Math.abs(fast.liftN/slow.liftN-4)<1e-12,'forces must scale with V², not interpolate endpoint N');
  assert.ok(Math.abs(yawed.liftN/slow.liftN-1/Math.cos(Math.PI/18)**2)<1e-12,'Cl is normalized by full inlet magnitude');
  for(const s of map.samples) s.loads.cl=(s.speedKmh===40 ? .1 : .5)+(s.yawDeg===10 ? .2 : 0);
  assert.ok(Math.abs(load(140,5).cl-.4)<1e-12,'interpolate coefficients over speed and yaw before applying dynamic pressure');
  for(const s of map.samples) s.loads.cl=-.2;
  assert.equal(load(80).liftN,0);
  assert.ok(Math.abs(load(80).downforceN-slow.liftN)<1e-10);
  assert.equal(load(20),null,'no force extrapolation below map speeds');
  assert.equal(load(100,11),null,'no force extrapolation beyond yaw coverage');
  delete map.samples[4].loads;
  assert.equal(load(100),null,'missing coefficients must not become zero load');
  assert.ok(load(40),'a missing zero-weight case must not invalidate an exact solved case');
});

test('wind-tunnel forces calibrate base grip at 100 km/h and downforce increases available lateral force', async () => {
  const { vehicleLoads,gripCalibration,lateralCapacity }=await server.ssrLoadModule('/src/track/vehicleAero.ts');
  const base={cl:.15,cd:.3,density:1.225,referenceArea:2.2,wheelbase:2.33,forceSettled:true,residualConverged:true};
  const wing={...base,cl:-.8}, mass=1150, grip=1.1;
  const air={speedKmh:100,relativeSpeedKmh:100,yawDeg:0};
  const calibration=gripCalibration(base,mass), baseLift=vehicleLoads(base,air).netLiftN, wingLift=vehicleLoads(wing,air).netLiftN;
  const baseCapacity=lateralCapacity(grip,mass,calibration,baseLift), wingCapacity=lateralCapacity(grip,mass,calibration,wingLift);
  assert.ok(Math.abs(baseCapacity/(mass*9.81)-1.1)<1e-12,'the base input includes the base car aero at 100 km/h');
  assert.ok(wingCapacity>baseCapacity+1000,'added downforce must raise the available lateral tyre force');
  assert.equal(vehicleLoads(wing,air).liftN,0);
  assert.ok(vehicleLoads(wing,air).downforceN>0);
  assert.ok(lateralCapacity(grip,mass,calibration,vehicleLoads({...base,cl:.8},air).netLiftN)<baseCapacity,'lift must reduce grip');
  assert.equal(lateralCapacity(grip,mass,calibration,mass*9.81*2),0,'do not create negative contact force');
  const { solve,initial }=await server.ssrLoadModule('/src/track/physics.ts');
  const { Vector3 }=await import('three');
  const circle=Array.from({length:180},(_,i)=>new Vector3(100*Math.cos(i/180*Math.PI*2),0,100*Math.sin(i/180*Math.PI*2)));
  const a=solve(circle,initial,{...base,cd:0},base), b=solve(circle,initial,{...wing,cd:0},base);
  assert.ok(b.lap<a.lap-1,'the lap solver must use the selected run, not a cosmetic wing toggle');
  assert.ok(b.speed.every((v,i)=>v>a.speed[i]));
  assert.equal(solve(circle,initial,base,base).lap,solve(circle,initial,base,base).lap);
});

test('track imports the wind-tunnel run geometry, enabled accessory parts and exact saved field', async () => {
  const { cfdFromRun }=await server.ssrLoadModule('/src/track/cfd.ts');
  const { vehicleAero }=await server.ssrLoadModule('/src/track/vehicleAero.ts');
  const positions=new Float32Array([-1,-.9,0,1,-.9,0,1,.9,1]);
  const wing=new Float32Array([.5,-1,1.3,1,-1,1.3,1,1,1.3]);
  const cp=new Float32Array([.1,.2,.3]);
  const field={origin:[-2,-2,0],spacing:[1,1,1],dims:[2,2,2],freestream:100/3.6,inlet:[100/3.6,0,0],length:4};
  const run={doc:{id:'wind-tunnel-fixture',designName:'MX-5 with wing',settings:{density:1.225,reference_area:2.2,speed_kmh:100,yaw_deg:0},result:{cl:-.8,cd:.4,cells:100,settled:true,warnings:[],openfoam:{residualConverged:true}}},
    parts:[{id:'body',name:'Body',role:'body',positions,wheel:null,enabled:true},{id:'wing',name:'Custom wing',role:'body',positions:wing,wheel:null,enabled:true}],
    field,surface:[{cp},{cp}],ranges:{cp:[-1.5,1],speed:[0,40]}};
  const data=cfdFromRun(run);
  assert.equal(data.field,field);
  assert.equal(data.parts[0].positions,positions);
  assert.equal(data.parts[1].positions,wing);
  assert.equal(data.parts[1].cp,cp);
  assert.equal(data.parts[1].info.name,'Custom wing');
  assert.equal(vehicleAero(data).cl,-.8);
  assert.equal(data.map,undefined,'do not reuse the stock-car map for a modified car');
  assert.throws(()=>cfdFromRun({...run,field:null}),/no saved geometry\/airflow/);
});

test('CFD force metadata reproduces the native solver averages at all six solved conditions', async () => {
  const { mapWeights, mapLoads } = await server.ssrLoadModule('/src/track/aeroMap.ts');
  const m=JSON.parse(await readFile(resolve(root,'public/track-cfd/map.json'),'utf8'));
  for(const s of m.samples) {
    const load=mapLoads(m,mapWeights(m,s.speedKmh,s.yawDeg));
    assert.ok(Math.abs(load.netLiftN+s.loads.downforceN)<1e-8,`${s.id}: exported Cl/reference normalization changed native force`);
    assert.equal(load.forceSettled,s.forceSettled);
    assert.equal(load.residualConverged,s.residualConverged);
    const cached=JSON.parse(await readFile(resolve(root,`public/track-cfd/map/${s.id}/sample.json`),'utf8'));
    assert.deepEqual(cached.loads,s.loads);
  }
  assert.equal(mapLoads(m,mapWeights(m,40,0)).forceSettled,true,'ignore an unsettled case at zero weight');
  assert.equal(mapLoads(m,mapWeights(m,140,0)).forceSettled,false,'retain unsettled force warnings during interpolation');
});

test('generated CFD map has six independently solved, compatible fields with changing yaw/pressure', async () => {
  const folder = resolve(root, 'public/track-cfd');
  const m = JSON.parse(await readFile(resolve(folder, 'map.json'), 'utf8'));
  assert.equal(m.samples.length,6); assert.equal(m.quality,'fast');
  const runIds = new Set();
  const cps = [], lateral = [];
  for (const s of m.samples) {
    runIds.add(s.runId); assert.equal(s.meshHash,m.meshHash); assert.equal(s.cells,39383);
    for (const [file,hash] of Object.entries(s.hashes)) {
      const raw=gunzipSync(await readFile(resolve(folder,file)));
      assert.equal(createHash('sha256').update(raw).digest('hex'),hash);
    }
    const cp=gunzipSync(await readFile(resolve(folder,s.cp.part0)));
    cps.push(createHash('sha256').update(cp).digest('hex'));
    const raw=gunzipSync(await readFile(resolve(folder,s.field)));
    const n=m.grid.dims.reduce((a,b)=>a*b,1);
    assert.equal(raw.length,n*21);
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    // A valid sample upstream of the nose: native velocity responds to the prescribed yaw.
    let sum=0,count=0;
    for(let i=0;i<n;i+=97)if(raw[20*n+i]){sum+=view.getFloat32(4*n+4*i,true);count++;}
    lateral.push(sum/count);
  }
  assert.equal(runIds.size,6);assert.equal(new Set(cps).size,6);
  assert.ok(lateral[0]<lateral[2]);assert.ok(lateral[3]<lateral[5]);
  assert.ok(m.samples.every(s=>s.residualConverged));
  assert.ok(m.samples.some(s=>!s.forceSettled)); // retain, do not erase the provisional case
});

for (const circuit of ['barcelona','monza','zandvoort']) test(`${circuit}: elevation preserves source heights with continuous grade, and terrain supports the road`, async () => {
  const { ElevationProfile } = await server.ssrLoadModule('/src/track/elevation.ts');
  const { TrackTerrain, terrainInput } = await server.ssrLoadModule('/src/track/terrain.ts');
  const data = JSON.parse(await readFile(resolve(root, `public/tracks/${circuit}.geojson`),'utf8'));
  const m=data.metadata.model3d, profile=new ElevationProfile(m.elevation,m.referenceLengthM), eps=.001;
  for(const [d,h] of m.elevation) {
    assert.ok(Math.abs(profile.at(d)-h)<1e-8,'source height changed');
    const left=(profile.at(d)-profile.at(d-eps))/eps;
    const right=(profile.at(d+eps)-profile.at(d))/eps;
    assert.ok(Math.abs(left-right)<.00003,`abrupt grade at source station ${d}: ${left} -> ${right}`);
  }
  const points=trackPoints(data), flat=trackPoints(data,false);
  assert.ok(flat.every(p=>p.y===0),'flat mode must not inject unverified terrain heights');
  const spacing=points.map((p,i)=>{const q=points[(i+1)%points.length];return Math.hypot(q.x-p.x,q.z-p.z);});
  assert.ok(Math.min(...spacing)>3.5,'arc-length table compressed road stations');
  assert.ok(Math.max(...spacing)<4.5,'road stations are not spaced in metres');
  const sourceSlope=Math.max(...m.elevation.slice(1).map((p,i)=>Math.abs((p[1]-m.elevation[i][1])/(p[0]-m.elevation[i][0]))));
  points.forEach((p,i)=>assert.ok(Math.abs(points[(i+1)%points.length].y-p.y)/spacing[i]<sourceSlope*1.7,'height is assigned by sample index instead of actual distance'));
  const path=new TrackPath(points), terrain=new TrackTerrain(path,terrainInput(data));
  for(const p of path.points) assert.ok(Math.abs(terrain.heightAt(p.x,p.z)-(p.y-.18))<.0001,'road floats above the terrain corridor');
  const pos=terrain.geometry.getAttribute('position').array;
  assert.ok(pos.every(Number.isFinite));
  // The old flat floor had no connected terrain around changing road heights.
  assert.ok(terrain.geometry.index.count>10000);
  terrain.geometry.dispose();
});
