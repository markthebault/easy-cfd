// OpenFOAM engine mappings: settings, frames and run records. Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, of, types;

before(async () => {
  server = await createServer({ root, define:{"import.meta.env.VITE_ENABLE_OPENFOAM":JSON.stringify("true")}, server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  [of, types] = await Promise.all([server.ssrLoadModule("/src/engine/openfoam.ts"), server.ssrLoadModule("/src/solver/types.ts")]);
});
after(async () => server?.close());

test("original surface assembly preserves every selected triangle and gap", () => {
  const first = new Float32Array([0,0,1,1,0,1,0,1,1]);
  const second = first.map(v=>v+10);
  const make=(name,positions,enabled=true)=>({id:name,name,file:name+'.stl',positions,role:'body',wheel:null,enabled});
  const assembly=of.originalSurfaceAssembly([make('body',first),make('wing',second),make('off',first,false)]);
  assert.deepEqual(Array.from(assembly.positions),[...first,...second]);
  assert.deepEqual(first,new Float32Array([0,0,1,1,0,1,0,1,1]));
  assert.equal(assembly.positions.length/9,2);
});

test("one assembly patch is sampled once and split back onto original parts", async () => {
  const originalFetch=globalThis.fetch;
  const points=new Float32Array([0,0,1,1,0,1,0,1,1]);
  const parts=['body','wing'].map((name,i)=>({id:name,name,file:name+'.stl',positions:points.map(v=>v+i*10),role:'body',wheel:null,enabled:true}));
  let calls=0;
  globalThis.fetch=async (url,init)=>{
    calls++;
    assert.match(url,/part_id=part0/);
    assert.deepEqual(Array.from(init.body),[...parts[0].positions,...parts[1].positions]);
    const bytes=new ArrayBuffer(16+29*6);
    new Uint32Array(bytes,0,4).set([0x53464345,2,6,50]);
    new Float32Array(bytes,16,6).set([1,2,3,4,5,6]);
    new Uint8Array(bytes,16+28*6,6).fill(1);
    return new Response(bytes,{headers:{'content-type':'application/octet-stream'}});
  };
  try {
    const result=await of.fetchSurface({id:'test',settings:{density:1.225,speed_kmh:100,yaw_deg:0},result:{provenance:{version:'openfoam-wall-integrals-2'}}},parts,[0,0,0],{'body.stl::body':'part0','wing.stl::wing':'part0'});
    assert.equal(calls,1);
    assert.deepEqual(Array.from(result[0].cp),[1,2,3]);
    assert.deepEqual(Array.from(result[1].cp),[4,5,6]);
    assert.equal(result[1].snapshot.iteration,50);
  } finally {globalThis.fetch=originalFetch;}
});

test("UI settings map to the server's settings; Custom quality becomes Medium", () => {
  const s = { ...types.DEFAULT_SETTINGS, quality: "custom", speed_kmh: 130, yaw_deg: 5, simulation_box: { x_min: -10, x_max: 20, y_min: -5, y_max: 5, z_max: 6 } };
  const out = of.serverSettings(s);
  assert.equal(out.quality, "medium");
  assert.equal(out.speed_kmh, 130);
  assert.equal(out.yaw_deg, 5);
  assert.deepEqual(out.simulation_box, s.simulation_box);
  assert.equal(out.geometry_confirmed, false);
  // Only fields the server accepts (its model forbids extra ones).
  assert.deepEqual(Object.keys(out).sort(), ["custom_iterations", "custom_mesh", "density", "flow_animation", "geometry_confirmed", "moving_ground", "quality", "reference_area", "simulation_box", "speed_kmh", "wheels", "yaw_deg"]);
});

test("road and wheel choices reach OpenFOAM independently, including explicit false", () => {
  for (const moving_ground of [false, true]) for (const wheels of [false, true]) {
    const out = of.serverSettings({ ...types.DEFAULT_SETTINGS, moving_ground, wheels });
    assert.equal(out.moving_ground, moving_ground);
    assert.equal(out.wheels, wheels);
  }
});

test("detailed recording requests its native wake mode while legacy settings keep their wire format", () => {
  const s=of.serverSettings({...types.DEFAULT_SETTINGS,engine:"openfoam",flow_animation:true,flow_detail:"fine",max_seconds:43200});
  assert.equal(s.flow_animation,true);
  assert.equal(s.flow_detail,"fine");
  assert.equal(s.profile,null);
  assert.equal(s.max_seconds,43200);
  assert.equal(of.serverSettings(types.DEFAULT_SETTINGS).flow_detail,undefined);
  assert.equal(of.serverSettings({...types.DEFAULT_SETTINGS,flow_detail:"standard"}).flow_detail,"standard");
});

test("weight inputs reach the backend and native tyre loads use the saved axle moment", () => {
  const weight = {vehicle_mass_kg:1200, front_weight_percent:55};
  const out = of.serverSettings({...types.DEFAULT_SETTINGS, ...weight});
  assert.equal(out.vehicle_mass_kg, 1200);
  assert.equal(out.front_weight_percent, 55);
  const record = {id:"a".repeat(32), settings:{speed_kmh:100,yaw_deg:0,density:1.225,reference_area:2,...weight,
    axles:{frontX:4,rearX:7,centrelineY:2,confirmed:true}},
    result:{cd:.3,cl:-.2,drag:100,downforce:90,
      aero:{force:[100,0,-90],moment:[0,180,0],origin:[4,2,0]}}};
  const result = of.resultFromRecord(record,4,[5,2,0],[0,0,0,0,0,0]);
  assert.deepEqual(result.aero.origin, [-1,0,0]);
  assert.equal(result.balance.frontLift, -30);
  assert.equal(result.balance.rearLift, -60);
  assert.ok(Math.abs(result.tyreLoads.front.totalN - (1200 * 9.80665 * .55 + 30)) < 1e-10);
  assert.ok(Math.abs(result.tyreLoads.rear.totalN - (1200 * 9.80665 * .45 + 60)) < 1e-10);
  delete record.settings.vehicle_mass_kg;
  assert.equal(of.resultFromRecord(record,4,[5,2,0],[0,0,0,0,0,0]).tyreLoads, undefined);
});

test("frame offset and domain conversion between the UI and the server", () => {
  const uiLow = [-2.1, -0.9, 0.01];
  const serverLow = [-2.05, -0.92, 0.01];
  const off = of.frameOffset(uiLow, serverLow);
  assert.ok(Math.abs(off[0] - 0.05) < 1e-12 && Math.abs(off[1] + 0.02) < 1e-12 && off[2] === 0);
  const d = of.domainToUi([-14, 26, -9, 9, 0, 9.5], off);
  assert.ok(Math.abs(d[0] + 14.05) < 1e-12 && Math.abs(d[2] + 8.98) < 1e-12 && d[4] === 0 && d[5] === 9.5);
  const soup = new Float32Array([1, 2, 3, -1, 5, 0.5, 0, -2, 7]);
  assert.deepEqual(of.soupLow(soup), [-1, -2, 0.5]);
});

test("a server run record becomes a UI run result", () => {
  const rec = {
    id: "a".repeat(32), project_id: "b".repeat(32), name: "x", created: "2026-09-28T10:00:00Z", status: "completed",
    started: "2026-09-28T10:00:00Z", finished: "2026-09-28T10:10:00Z", iteration: 300,
    settings: { speed_kmh: 100, yaw_deg: 0, quality: "fast", reference_area: 2, density: 1.225 },
    domain: [-14, 26, -9, 9, 0, 9.5],
    geometry: { parts: [] },
    result: {
      cd: 0.35, cl: -0.05, drag: 330, downforce: 47, force_settled: true, cd_span: 0.004, cl_span: 0.01, averaging_iterations: 50,
      history: [{ iteration: 1, cd: 1, cl: 0 }, { iteration: 2, cd: 0.5, cl: 0.1 }],
      breakdown: { body: { pressure_drag: 250, viscous_drag: 12, pressure_downforce: 40, viscous_downforce: 1 }, wheels: { pressure_drag: 60, viscous_drag: 8, pressure_downforce: 6, viscous_downforce: 0 } },
      blockage_ratio: 0.012, cells: 350000, iteration: 300, warnings: ["w"], residuals: { p: 1e-3 }, residual_converged: false,
    },
  };
  const r = of.resultFromRecord(rec, 4.0, [0.05, 0, 0], [0, 0, 0, 0, 0, 0]);
  assert.equal(r.engine, "openfoam");
  assert.equal(r.cd, 0.35);
  assert.equal(r.lift, -47);
  assert.equal(r.downforce, 47);
  assert.deepEqual(r.breakdown.bodyPressure, [250, 0, -40]);
  assert.deepEqual(r.breakdown.wheelViscous, [8, 0, -0]);
  assert.equal(r.wallSeconds, 600);
  assert.equal(r.cdBand, 0.002);
  assert.deepEqual(r.history[1], { time: 2, step: 2, cd: 0.5, cl: 0.1, cs: 0 });
  assert.ok(Math.abs(r.domain[0] + 14.05) < 1e-12);
  assert.equal(r.openfoam.iterations, 300);
  assert.equal(r.openfoam.averagingIterations, 50);
  assert.equal(r.gridId, `openfoam:${rec.id}`);
  assert.ok(Math.abs(r.freestream - 100 / 3.6) < 1e-12);
});


test("advanced profile and confirmed axles map without reinterpreting old presets", () => {
 const axes={frontX:-1,rearX:2,centrelineY:0,confirmed:true};
 const s=of.serverSettings({...types.DEFAULT_SETTINGS,engine:"openfoam",profile:"advanced2",max_seconds:90,axles:axes,refine_groups:["g:wing"],refine_underfloor:false});
 assert.deepEqual(s.axles,axes);assert.equal(s.profile,"advanced2");assert.equal(s.max_seconds,90);
 assert.deepEqual(s.refine_groups,["g:wing"]);assert.equal(s.refine_underfloor,false);
 const legacy=of.serverSettings(types.DEFAULT_SETTINGS);assert.equal(legacy.profile,undefined);assert.equal(legacy.axles,undefined);assert.equal(legacy.refine_underfloor,undefined);
});


test("native refinement retains load sensitivity and translated origins for every mesh", () => {
  const axles = {frontX:-1,rearX:2,centrelineY:0,confirmed:true};
  const level = (cd, pitch) => ({preset:"mesh",cells:100,cd,cl:-.2,drag:100,downforce:90,
    aero:{force:[100,0,-90],moment:[0,pitch,0],origin:[4,2,0],pressureMoment:[0,pitch,0],frictionMoment:[0,0,0]}});
  const record = {id:"a".repeat(32), settings:{speed_kmh:100,yaw_deg:0,density:1.225,reference_area:2,axles},
    result:{cd:.32,cl:-.2,drag:100,downforce:90,refinement_levels:[level(.3,90),level(.32,120),level(.31,180)]}};
  const result = of.resultFromRecord(record,4,[5,2,0],[0,0,0,0,0,0]);
  assert.deepEqual(result.levels.map(l=>l.aero.origin),[[-1,0,0],[-1,0,0],[-1,0,0]]);
  assert.equal(result.meshSensitivity.frontLift,30);
  assert.equal(result.meshSensitivity.rearLift,30);
  assert.equal(result.meshSensitivity.pitch,90);
  assert.ok(Math.abs(result.meshSensitivity.dCd-.02)<1e-12);
  delete record.settings.axles;
  assert.equal(of.resultFromRecord(record,4,[5,2,0],[0,0,0,0,0,0]).meshSensitivity.frontLift,undefined);
  assert.equal(result.cdBand,undefined);
  assert.equal(result.clBand,undefined);
});


test("old Medium time limits are capped before reaching OpenFOAM, including standard recording",()=>{
  for (const profile of [undefined,"regular"]) for(const flow_animation of [false,true]) {
    const settings={...types.DEFAULT_SETTINGS,quality:"medium",profile,flow_animation,max_seconds:10800};
    assert.equal(of.serverSettings(settings).max_seconds,1200);
    assert.equal(of.serverSettings({...settings,max_seconds:120}).max_seconds,120);
  }
  assert.equal(of.serverSettings({...types.DEFAULT_SETTINGS,profile:"advanced1",max_seconds:10800}).max_seconds,10800);
  assert.equal(of.serverSettings({...types.DEFAULT_SETTINGS,flow_animation:true,flow_detail:"fine",max_seconds:43200}).max_seconds,43200);
});


test("Medium timing history excludes detailed wake, advanced and old mesh budgets",async()=>{
  const fetchBefore=globalThis.fetch;
  const preset={cell:.6,surface:3,wake:2,layers:3,max_cells:700000,iterations:600,residual:1e-4,label:"Design comparison",memory_gb:4};
  const run=(seconds,settings,mesh_preset)=>({status:"completed",settings:{quality:"medium",...settings},mesh_preset,started:"2026-10-08T00:00:00Z",finished:new Date(Date.parse("2026-10-08T00:00:00Z")+seconds*1000).toISOString()});
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('/health')?{ready:true,presets:{medium:preset}}:[
    run(120,{profile:"regular"},preset),run(12000,{flow_animation:true,flow_detail:"fine"},preset),
    run(3600,{profile:"advanced1"},preset),run(900,{},undefined),
  ]),{headers:{'content-type':'application/json'}});
  try{assert.deepEqual((await of.probeServer()).measured.medium,{seconds:120,runs:1});}
  finally{globalThis.fetch=fetchBefore;}
});

test("quick import test reaches the backend without changing ordinary Fast", () => {
  const settings=of.serverSettings({...types.DEFAULT_SETTINGS,engine:"openfoam",profile:"regular",import_test:true,max_seconds:180});
  assert.equal(settings.import_test,true);
  assert.equal(settings.profile,null);
  assert.equal(settings.quality,"fast");
  assert.equal(settings.max_seconds,180);
  assert.equal(of.serverSettings(types.DEFAULT_SETTINGS).import_test,undefined);
});
