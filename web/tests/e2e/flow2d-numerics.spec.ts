import { expect, test } from "@playwright/test";

test("all physical box grids develop finite flow and respect their solid masks", async ({page}) => {
  await page.emulateMedia({reducedMotion:"reduce"}); await page.goto("/?workspace=2d&flow-wasm");
  const results = await page.evaluate(async()=>{
    const gpuPath="/src/flow2d/gpu.ts", geometryPath="/src/flow2d/geometry.ts", gridPath="/src/flow2d/grid.ts";
    const {GpuLBM}=await import(gpuPath), {maskFor,PRESETS}=await import(geometryPath), {TUNNELS,liveTau}=await import(gridPath), results=[];
    for(const id of ["small","medium","large"]){const grid=TUNNELS[id],n=grid.nx*grid.ny,mask=maskFor(PRESETS[id==="large"?"car":"airfoil"].points,grid.nx,grid.ny,grid);
      const solver=await GpuLBM.create(grid.nx,grid.ny,mask,liveTau(grid),.1);if(!solver)return null;
      try {solver.advance(4096);const field=await solver.field();let masked=true,maxVertical=0,maxPressure=0;
        for(let i=0;i<n;i++){if(mask[i]&&(field[i]!==0||field[n+i]!==0))masked=false;maxVertical=Math.max(maxVertical,Math.abs(field[n+i]));maxPressure=Math.max(maxPressure,Math.abs(field[2*n+i]));}
        results.push({id,cells:n,finite:field.every(Number.isFinite),masked,maxVertical,maxPressure});
      }finally{solver.dispose();}
    }return results;
  });
  test.skip(!results,"No WebGPU adapter");expect(results).toHaveLength(3);for(const r of results!){expect(r.cells).toBeGreaterThan(129024);expect(r.finite,r.id).toBe(true);expect(r.masked,r.id).toBe(true);expect(r.maxVertical,r.id).toBeGreaterThan(.02);expect(r.maxPressure,r.id).toBeLessThan(100);}
});

test("fused GPU fields agree with the portable AeroJAX equations", async ({ page }) => {
  await page.goto("/?workspace=2d&flow-wasm");
  const result = await page.evaluate(async () => {
    const gpuPath = "/src/flow2d/gpu.ts", lbmPath = "/src/flow2d/lbm.ts", geometryPath = "/src/flow2d/geometry.ts";
    const { GpuLBM } = await import(gpuPath), { BrowserLBM } = await import(lbmPath), { maskFor, PRESETS } = await import(geometryPath);
    const nx = 128, ny = 48, n = nx * ny, mask = maskFor(PRESETS.cylinder.points, nx, ny);
    const gpu = await GpuLBM.create(nx, ny, mask, .506, .1); if (!gpu) return null;
    await BrowserLBM.backend(true); const portable = new BrowserLBM(nx, ny, mask, .506, .1);
    try {
      gpu.advance(240); portable.advance(240);
      const a = await gpu.field(), b = await portable.field();
      const ga = await gpu.forces(), wb = await portable.forces();
      let velocityError = 0, pressureError = 0;
      for (let i = 0; i < n; i++) { velocityError = Math.max(velocityError, Math.abs(a[i] - b[i]), Math.abs(a[n+i] - b[n+i])); pressureError = Math.max(pressureError, Math.abs(a[2*n+i] - b[2*n+i])); }
      return { velocityError, pressureError, forceError: Math.max(Math.abs(ga.x-wb.x),Math.abs(ga.y-wb.y))/240, finite: a.every(Number.isFinite) && b.every(Number.isFinite) };
    } finally { gpu.dispose(); portable.dispose(); }
  });
  test.skip(!result, "This browser has no WebGPU adapter.");
  expect(result!.finite).toBe(true);
  expect(result!.velocityError).toBeLessThan(.002);
  expect(result!.pressureError).toBeLessThan(.05);
  expect(result!.forceError).toBeLessThan(.0005);
});

test("measured section forces respond to angle and added parts, with correct symmetry and batch integration", async ({page}, testInfo) => {
  await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/?workspace=2d&flow-wasm");
  const result=await page.evaluate(async()=>{
    const gpuPath="/src/flow2d/gpu.ts", geometryPath="/src/flow2d/geometry.ts";
    const {GpuLBM}=await import(gpuPath),{maskFor}=await import(geometryPath),nx=201,ny=101,domain={width:4,height:2};
    const profile=[];
    for(let i=0;i<=80;i++){const x=(1-Math.cos(Math.PI*i/80))/2,y=.6*(.2969*Math.sqrt(x)-.126*x-.3516*x*x+.2843*x**3-.1036*x**4);profile.push({x:1+.8*x,y:1+.8*y});}
    for(let i=79;i>0;i--){const x=(1-Math.cos(Math.PI*i/80))/2,y=.6*(.2969*Math.sqrt(x)-.126*x-.3516*x*x+.2843*x**3-.1036*x**4);profile.push({x:1+.8*x,y:1-.8*y});}
    const rotate=(angle:number)=>profile.map(p=>{const a=angle*Math.PI/180,x=p.x-1.4,y=p.y-1;return{x:1.4+x*Math.cos(a)-y*Math.sin(a),y:1+x*Math.sin(a)+y*Math.cos(a)};});
    const calculate=async(angle:number,part=false)=>{
      const mask=maskFor(rotate(angle),nx,ny,domain);
      if(part){const added=maskFor([{x:1.85,y:1.22},{x:2.2,y:1.12},{x:2.2,y:1.2},{x:1.85,y:1.3}],nx,ny,domain);for(let i=0;i<mask.length;i++)mask[i]=Math.max(mask[i],added[i]);}
      const solver=await GpuLBM.create(nx,ny,mask,.53,.1);if(!solver)return null;
      try {solver.advance(2048);await solver.field();let x=0,y=0;
        for(let i=0;i<16;i++){solver.advance(128);const f=await solver.forces();x+=f.x;y+=f.y;}
        const factor=2*.02/(.065**2*.8*2048);return{cd:x*factor,cl:y*factor};
      }finally{solver.dispose();}
    };
    const zero=await calculate(0);if(!zero)return null;
    const positive=await calculate(12),negative=await calculate(-12),part=await calculate(12,true);
    const mask=maskFor(rotate(12),nx,ny,domain),one=await GpuLBM.create(nx,ny,mask,.53,.1),many=await GpuLBM.create(nx,ny,mask,.53,.1);
    let batchError=Infinity;
    try {one!.advance(256);const total=await one!.forces();let x=0,y=0;for(const count of [17,39,72,128]){many!.advance(count);const f=await many!.forces();x+=f.x;y+=f.y;}batchError=Math.max(Math.abs(x-total.x),Math.abs(y-total.y))/256;}finally{one?.dispose();many?.dispose();}
    const empty=await GpuLBM.create(nx,ny,new Float32Array(nx*ny),.53,.1);let emptyForce;
    try{empty!.advance(32);emptyForce=await empty!.forces();}finally{empty?.dispose();}
    return{zero,positive:positive!,negative:negative!,part:part!,batchError,emptyForce};
  });
  test.skip(!result,"No WebGPU adapter");
  await testInfo.attach("force-response.json",{body:JSON.stringify(result,null,2),contentType:"application/json"});
  expect(result!.zero.cd).toBeGreaterThan(0);expect(Math.abs(result!.zero.cl)).toBeLessThan(.005);
  expect(result!.positive.cd).toBeGreaterThan(0);expect(result!.negative.cd).toBeCloseTo(result!.positive.cd,2);
  expect(result!.positive.cl).toBeLessThan(-.05);expect(result!.negative.cl).toBeGreaterThan(.05);
  expect(result!.negative.cl).toBeCloseTo(-result!.positive.cl,2);
  expect(Math.abs(result!.part.cd-result!.positive.cd)+Math.abs(result!.part.cl-result!.positive.cl)).toBeGreaterThan(.02);
  expect(result!.batchError).toBeLessThan(.00001);expect(result!.emptyForce).toEqual({x:0,y:0,steps:32});
});

test("GPU smoke keeps a stationary tracer instead of clearing it between passes", async ({ page }) => {
  await page.goto("/?workspace=2d&flow-wasm");
  const retained = await page.evaluate(async () => {
    const path = "/src/flow2d/Smoke2D.ts", gridPath = "/src/flow2d/geometry.ts", { Smoke2D } = await import(path), { NX, NY } = await import(gridPath), smoke = new Smoke2D();
    smoke.update(new Float32Array(NX * NY * 3), new Float32Array(NX * NY));
    function mass() {
      const target = smoke.dye, values = new Uint16Array(target.width * target.height * 4);
      smoke.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, values);
      let sum = 0;
      for (let i = 0; i < values.length; i += 4) { const x = values[i], exponent = x >> 10 & 31, mantissa = x & 1023; sum += exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15); }
      return sum;
    }
    try { smoke.render(0, true, 1); const start = mass(); for (let i = 0; i < 20; i++) smoke.render(.02, true, 1); return mass() / start; }
    finally { smoke.dispose(); }
  });
  // Half-float targets and repeated bilinear reconstruction introduce small loss.
  // The framebuffer feedback regression removed over 90% in this interval.
  expect(retained).toBeGreaterThan(.9);
  expect(retained).toBeLessThan(1.05);
});

test("the inverted rear-wing preset produces negative lift as an isolated section",async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});await page.goto('/?workspace=2d&flow-wasm');
  const result=await page.evaluate(async()=>{
    const gpuPath='/src/flow2d/gpu.ts',geometryPath='/src/flow2d/geometry.ts';
    const{GpuLBM}=await import(gpuPath),{maskFor,PRESETS}=await import(geometryPath),grid={width:3,height:2},nx=301,ny=201;
    const solver=await GpuLBM.create(nx,ny,maskFor(PRESETS['inverted-airfoil'].points,nx,ny,grid),.53,.1);if(!solver)return null;
    try{solver.advance(4096);await solver.field();solver.advance(4096);const force=await solver.forces();return{x:force.x/force.steps,y:force.y/force.steps};}finally{solver.dispose();}
  });
  test.skip(!result,'No WebGPU adapter');expect(result!.x).toBeGreaterThan(0);expect(result!.y).toBeLessThan(-.005);
});
