import { expect, test } from '@playwright/test';

test.setTimeout(120_000);
test.use({ actionTimeout: 10_000 });

test('track lap uses solved OpenFOAM data, holds tire contact, pauses and exposes the underside', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?workspace=track');
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'CFD source' })).toContainText('Precomputed OpenFOAM');
  const lift = page.locator('output[aria-label="CFD lift"]');
  const downforce = page.locator('output[aria-label="CFD downforce"]');
  await expect(lift).toHaveAttribute('data-newtons', /\d/);
  const readLoads = async () => ({ lift: await lift.getAttribute('data-newtons'), downforce: await downforce.getAttribute('data-newtons') });
  const expectedLift = () => page.evaluate(() => {
    const s = (window as any).__trackStage;
    const active = s.car.activeIndices.split(',').map((index: string, i: number) => ({ info: s.car.data.map.samples[Number(index)].info, weight: s.car.weights.toArray()[i] }));
    const weighted = (f: (info: any) => number) => active.reduce((sum: number, a: any) => sum + a.weight * f(a.info), 0);
    const speed = weighted(i => i.speedKmh) / 3.6 / Math.cos(weighted(i => i.yawDeg) * Math.PI / 180);
    const reference = active[0].info.loads;
    return .5 * reference.density * reference.referenceArea * speed ** 2 * weighted(i => i.loads.cl);
  });
  await expect(page.getByRole('checkbox',{name:'Estimated elevation',exact:true})).not.toBeChecked();
  expect(await page.evaluate(()=>(window as any).__trackStage.path.points.every((p:any)=>p.y===0))).toBe(true);
  const data = await page.evaluate(() => {
    const s = (window as any).__trackStage;
    return { points: s.car.data.field.u.length, triangles: s.car.data.parts.reduce((n: number, p: any) => n + p.positions.length / 9, 0), streamPoints: s.car.streamPointCount, sky: !!s.scene.getObjectByName('Daylight skybox'), kerbs: s.environment.kerbs.map((m: any) => m.geometry.index.count), calls: s.renderer.info.render.calls };
  });
  expect(data.points).toBe(909293);
  expect(data.triangles).toBe(470000);
  expect(data.streamPoints).toBeGreaterThan(10000);
  expect(data.sky).toBe(true);
  expect(data.kerbs.every((n: number) => n > 100)).toBe(true);
  expect(data.calls).toBeLessThan(50); // Kerbs use merged strips, not hundreds of separate boxes.

  await page.getByRole('combobox', { name: 'Airflow display' }).selectOption('streamlines');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
  const frozen = () => page.evaluate(() => {
    const s = (window as any).__trackStage;
    return { elapsed: s.elapsed, position: s.car.group.position.toArray(), quaternion: s.car.group.quaternion.toArray(), flow: s.car.time };
  });
  const before = await frozen();
  await page.waitForTimeout(350);
  expect(await frozen()).toEqual(before);
  const heldLoads = await readLoads();
  await page.waitForTimeout(150);
  expect(await readLoads()).toEqual(heldLoads);
  await page.keyboard.press('f');
  await expect(page.getByRole('button', { name: /Free camera/ })).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).__trackStage;
    s.controls.enableDamping = false;
    s.camera.position.copy(s.car.group.position).add({ x: 4, y: -2, z: 5 });
    s.controls.target.copy(s.car.group.position).add({ x: 0, y: .3, z: 0 });
    s.controls.update();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__trackStage.environment.opacity)).toBeLessThan(.07);
  expect(await page.evaluate(() => (window as any).__trackStage.environment.materials.every((m: any) => !m.depthWrite))).toBe(true);
  expect(await frozen()).toEqual(before);
  await page.screenshot({ path: 'test-results/track-lab-underbody.png' });
  await page.evaluate(() => {
    const s = (window as any).__trackStage;
    s.camera.position.copy(s.car.group.position).add({ x: 4, y: 3, z: 5 });
    s.controls.update();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__trackStage.environment.opacity)).toBeGreaterThan(.99);

  // Verify wheel contact against the ACTUAL swept road mesh, including uphill/downhill sections.
  const lapLoads: number[] = [];
  for (const progress of [50, 275, 490, 735, 995]) {
    await page.getByRole('slider', { name: 'Lap progress' }).fill(String(progress));
    await expect.poll(() => page.evaluate(() => Math.round((window as any).__trackStage.elapsed / (window as any).__trackStage.timeKey.lap * 1000))).toBe(progress);
    await expect.poll(async () => Math.round(Number(await page.getByRole('region',{name:'Live telemetry'}).getAttribute('data-progress'))*1000)).toBe(progress);
    const contact = await page.evaluate(async () => {
      // @ts-expect-error Vite serves the installed browser ESM module in dev.
      const T = await import('/node_modules/three/build/three.module.js');
      const s = (window as any).__trackStage;
      s.scene.updateMatrixWorld(true);
      const up = new T.Vector3(0, 1, 0).applyQuaternion(s.car.group.quaternion);
      return s.car.data.parts.filter((p: any) => p.info.wheel).map((p: any) => {
        const wheel = p.info.wheel;
        const center = new T.Vector3(...wheel.center).applyMatrix4(s.car.solverFrame.matrixWorld);
        const bottom = center.clone().addScaledVector(up, -wheel.radius);
        const ray = new T.Raycaster(bottom.clone().addScaledVector(up, 2), up.clone().negate());
        const hits = ray.intersectObject(s.environment.road);
        return hits.length ? 2 - hits[0].distance : null;
      });
    });
    for (const gap of contact) { expect(gap).not.toBeNull(); expect(Math.abs(gap!)).toBeLessThan(.025); }
    await expect.poll(async () => Number(await lift.getAttribute('data-newtons'))).toBeCloseTo(await expectedLift(), 6);
    expect(Number(await downforce.getAttribute('data-newtons'))).toBe(0);
    lapLoads.push(Number(await lift.getAttribute('data-newtons')));
  }
  expect(Math.max(...lapLoads)-Math.min(...lapLoads)).toBeGreaterThan(5);

  const operating = () => page.evaluate(() => {
    const s = (window as any).__trackStage;
    return { weights: s.car.weights.toArray(), indices: s.car.activeIndices, yaw: document.querySelector('[aria-label="CFD source"] b')?.textContent, stream: s.car.streamKey };
  });
  const firstOperating = await operating();
  const firstLift = await lift.getAttribute('data-newtons');
  const parkedPosition = (await frozen()).position;
  await page.locator('.track-wind summary').click();
  await page.getByRole('spinbutton', { name: 'Wind speed', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: 'Wind direction', exact: true }).fill('90');
  await expect.poll(async () => JSON.stringify((await operating()).weights)).not.toBe(JSON.stringify(firstOperating.weights));
  await expect.poll(async () => (await operating()).stream).not.toBe(firstOperating.stream);
  await expect.poll(() => lift.getAttribute('data-newtons')).not.toBe(firstLift);
  await expect.poll(async () => Number(await lift.getAttribute('data-newtons'))).toBeCloseTo(await expectedLift(), 6);
  const adjustedPosition = (await frozen()).position;
  expect(Math.hypot(...parkedPosition.map((v:number,i:number)=>v-adjustedPosition[i]))).toBeLessThan(1e-6);
  await page.getByRole('spinbutton', { name: 'Wind speed', exact: true }).fill('0');

  await expect(page.getByRole('button', { name: 'Open wind tunnel',exact:true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live telemetry' })).toContainText('Lateral limit');
  await page.getByRole('combobox', { name: 'Airflow display' }).selectOption('smoke');
  await expect.poll(() => page.evaluate(() => (window as any).__trackStage.car.smoke.mesh.visible)).toBe(true);
  await page.getByRole('combobox', { name: 'Airflow display' }).selectOption('streamlines');

  for (const track of ['monza', 'zandvoort', 'barcelona']) {
    await page.getByRole('combobox', { name: 'Circuit', exact: true }).selectOption(track);
    await expect(page.locator('.track-lab')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    expect(await page.evaluate(() => document.querySelectorAll('.track-stage canvas').length)).toBe(1);
  }
  await page.getByRole('checkbox',{name:'Estimated elevation',exact:true}).check();
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready','true');
  expect(await page.evaluate(()=>(window as any).__trackStage.path.points.some((p:any)=>Math.abs(p.y)>1))).toBe(true);
  await page.getByRole('checkbox',{name:'Estimated elevation',exact:true}).uncheck();
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready','true');
  await page.screenshot({ path: 'test-results/track-lab-barcelona.png' });
  await page.getByRole('button', { name: 'Choose workspace' }).click();
  await page.getByRole('menuitemradio', { name: /3D wind tunnel/ }).click();
  await expect(page.locator('.track-lab')).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose workspace' }).click();
  await page.getByRole('menuitemradio', { name: /Track lab/ }).click();
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  expect(await page.evaluate(() => document.querySelectorAll('.track-stage canvas').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('wind-tunnel base and modified runs transfer their actual parts and feed the track grip/lap model', async ({ page }) => {
  const errors: string[]=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.goto('/?workspace=track');
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready','true',{timeout:60_000});
  // In-memory completed-run fixtures exercise the transfer; these synthetic force coefficients
  // are test inputs, never published CFD results or saved to the user's run library.
  await page.evaluate(async () => {
    // @ts-expect-error browser ESM fixture
    const T=await import('/node_modules/three/build/three.module.js');
    // @ts-expect-error browser ESM fixture
    const {DEFAULT_SETTINGS}=await import('/src/solver/types.ts');
    // @ts-expect-error browser ESM fixture
    const {DEFAULT_IMPORT}=await import('/src/geometry/model.ts');
    const data=(window as any).__trackStage.car.data;
    const parts=data.parts.map((p:any)=>({...p.info,file:'fixture-car.stl',enabled:true,positions:p.positions,base:true}));
    const surfaces=data.parts.map((p:any)=>({cp:p.cp,shear:new Float32Array(p.cp.length*3)}));
    const wingGeometry=new T.BoxGeometry(.4,1.6,.06).toNonIndexed();wingGeometry.translate(1.6,0,1.3);
    const wing={id:'fixture-wing-part',name:'Rear wing fixture',file:'fixture-wing.stl',role:'body',enabled:true,positions:wingGeometry.getAttribute('position').array,wheel:null,base:false,group:'rear-wing'};
    const make=(id:string,name:string,cl:number,withWing:boolean)=>{
      const density=1.225,area=2.2,U=100/3.6,q=.5*density*U*U,cd=.3;
      const result={cd,cl,cs:0,drag:q*area*cd,lift:q*area*cl,downforce:-q*area*cl,side:0,engine:'openfoam',
        settled:true,cdSpan:0,clSpan:0,cells:39383,steps:100,simulatedTime:100,wallSeconds:1,freestream:U,dynamicPressure:q,
        domain:[-10,20,-5,5,0,6],blockage:.01,warnings:[],history:[{time:99,step:99,cd,cl,cs:0,drag:q*area*cd,lift:q*area*cl,side:0}],
        breakdown:{bodyPressure:[q*area*cd,0,q*area*cl],bodyViscous:[0,0,0],wheelPressure:[0,0,0],wheelViscous:[0,0,0]},
        openfoam:{run:id,runtime:'wasm',iterations:100,averagingIterations:50,residuals:{p:1e-5},residualConverged:true,offset:[0,0,0]}};
      const enabled=withWing?[...parts,wing]:parts;
      const groups=withWing?[{id:'rear-wing',name:'Rear wing',enabled:true,parts:1}]:[];
      return {doc:{id,designId:'fixture-design',designName:name,createdAt:Date.now(),settings:{...DEFAULT_SETTINGS,vehicle_mass_kg:1150},
        source:{kind:'sample',wing:withWing},importOptions:DEFAULT_IMPORT,overrides:{},groups:[],adapter:'Track transfer test fixture',hasField:true,result,
        geometry:{dimensions:[4.1,1.8,1.4],triangles:470000,frontalArea:2.2,parts:enabled.map((p:any)=>({key:p.id,name:p.name,role:p.role,enabled:true,triangles:p.positions.length/9,radius:p.wheel?.radius??null,group:p.group})),groups}},
        parts:enabled,field:data.field,surface:withWing?[...surfaces,{cp:new Float32Array(wing.positions.length/3).fill(-1),shear:new Float32Array(wing.positions.length)}]:surfaces,
        ranges:{cp:[-1.5,1],speed:[0,45],pressure:[-1000,1000],k:[0,1],cp0:[-2,1],q,density}};
    };
    (window as any).__trackRunFixtures={base:make('fixture-base','Fixture base car',.15,false),wing:make('fixture-wing','Fixture car + rear wing',-.8,true)};
  });
  await page.getByRole('button',{name:'Open wind tunnel',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>!!(window as any).__easycfd)).toBe(true);
  await page.evaluate(()=> (window as any).__easycfd.app.set({run:(window as any).__trackRunFixtures.base,view:'results'}));
  await page.getByRole('button',{name:'Test on track',exact:true}).click();
  await expect(page.locator('.track-lab')).toHaveAttribute('data-cfd-run','fixture-base');
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready','true',{timeout:60_000});
  await page.getByRole('button',{name:'Use test as base',exact:true}).click();
  await expect(page.getByTestId('lap-gain')).toHaveText('0.00 s');
  await page.getByRole('spinbutton',{name:'Base lateral grip · g',exact:true}).fill('1.25');
  await page.getByRole('combobox',{name:'Circuit',exact:true}).selectOption('monza');
  await page.getByRole('button',{name:'Open wind tunnel',exact:true}).click();
  await page.evaluate(()=> (window as any).__easycfd.app.set({run:(window as any).__trackRunFixtures.wing,view:'results'}));
  await page.getByRole('button',{name:'Test on track',exact:true}).click();
  await expect(page.locator('.track-lab')).toHaveAttribute('data-cfd-run','fixture-wing');
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready','true',{timeout:60_000});
  await expect(page.getByRole('spinbutton',{name:'Base lateral grip · g',exact:true})).toHaveValue('1.25');
  await expect(page.getByRole('combobox',{name:'Circuit',exact:true})).toHaveValue('monza');
  await expect(page.getByRole('region',{name:'CFD source'})).toContainText('Single-condition CFD');
  await expect(page.getByRole('region',{name:'CFD source'})).toContainText('Flow shape stays at the solved yaw');
  await expect.poll(async()=>Number(await page.locator('output[aria-label="CFD downforce"]').getAttribute('data-newtons'))).toBeGreaterThan(100);
  expect(Number(await page.locator('output[aria-label="CFD lift"]').getAttribute('data-newtons'))).toBe(0);
  await expect.poll(async()=>parseFloat(await page.getByTestId('lap-gain').innerText())).toBeGreaterThan(0);
  const transfer=await page.evaluate(()=>{
    const s=(window as any).__trackStage,state=s.readState();
    return {names:s.car.data.parts.map((p:any)=>p.info.name),baseCl:state.baseAero.cl,testCl:state.aero.cl,map:!!s.car.data.map,calibration:state.result.calibration};
  });
  expect(transfer.names).toContain('Rear wing fixture');
  expect(transfer.baseCl).toBe(.15);expect(transfer.testCl).toBe(-.8);expect(transfer.map).toBe(false);
  expect(transfer.calibration).toBeGreaterThan(1);
  await expect(page.getByLabel('Lateral grip gain')).toContainText('+');
  await page.getByRole('button',{name:/Pause/}).click();
  await page.getByRole('slider',{name:'Lap progress'}).fill('500');
  await page.setViewportSize({width:1280,height:800});
  const telemetry=await page.getByRole('region',{name:'Live telemetry'}).boundingBox();
  const source=await page.getByRole('region',{name:'CFD source'}).boundingBox();
  expect(telemetry!.y+telemetry!.height).toBeLessThan(source!.y);
  await page.getByRole('button',{name:'Return to stock MX-5',exact:true}).click();
  await expect(page.getByRole('region',{name:'CFD source'})).toContainText('Precomputed OpenFOAM');
  await expect(page.getByTestId('lap-gain')).toHaveText('0.00 s');
  expect(errors).toEqual([]);
});
