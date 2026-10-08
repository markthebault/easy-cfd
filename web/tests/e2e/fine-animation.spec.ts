import { expect, test } from "@playwright/test";

const backend = process.env.EASYCFD_FINE_BACKEND;
const runId = process.env.EASYCFD_FINE_RUN;

test("native DDES sections retain computed detail through playback, switching and offline reopening", async ({page,request}) => {
  test.skip(!backend || !runId,"Requires a completed detailed native recording.");
  test.setTimeout(1_200_000);
  const errors:string[]=[];
  page.on("pageerror",e=>{errors.push(e.message);console.error("Browser error:",e.message);});
  await page.route("**/api/**",async route=>{
    const req=route.request(), url=new URL(req.url());
    const response=await request.fetch(`${backend}${url.pathname}${url.search}`,{
      method:req.method(),data:req.postDataBuffer() ?? undefined,headers:req.headers(),timeout:120000,
    });
    if(url.pathname==="/api/runs") {
      const records=await response.json();
      await route.fulfill({contentType:"application/json",body:JSON.stringify(records.filter((r:{id:string})=>r.id===runId))});
      await response.dispose();return;
    }
    await route.fulfill({response});
    await response.dispose();
  });
  await page.goto("/");
  await page.getByTestId("open-library").click();
  await page.getByTestId("tab-server").click();
  await page.getByTestId("server-run").filter({hasText:"click to open"}).click();
  await expect(page.getByTestId("card-cd")).toBeVisible({timeout:420000});
  const original=await page.evaluate(()=>{
    const r=(window as any).__easycfd.app.get().run,a=r.animation;
    const first=a.frames[0].field,last=a.frames.at(-1).field;
    let changed=0,fluid=0;
    for(let i=0;i<first.u.length;i++) if(!first.solid[i]) {fluid++;if(Math.abs(last.u[i]-first.u[i])>.1) changed++;}
    return {id:r.doc.id,result:JSON.stringify(r.doc.result),frames:a.frames.length,version:a.version,sections:a.sections.length,section:a.section,dims:first.dims,spacing:first.spacing,times:a.frames.map((f:any)=>f.time),changed,fluid,settings:r.doc.settings};
  });
  expect(original.version).toBe(2);
  expect(original.sections).toBe(4);
  expect(original.frames).toBeGreaterThanOrEqual(189);
  expect(original.frames).toBeLessThanOrEqual(195);
  expect(original.dims.filter((d:number)=>d===1)).toHaveLength(1);
  expect(Math.min(...original.spacing)).toBeLessThan(.03);
  expect(original.changed/original.fluid).toBeGreaterThan(.03);
  expect(original.times.every((t:number,i:number)=>!i || t>original.times[i-1])).toBe(true);
  expect(original.settings.flow_detail).toBe("fine");
  const cache = await page.evaluate(async id => {
    const {get} = await import("/src/store/db.ts");
    const saved = await get("fields",id);
    return {frames:saved?.animation?.frames.length,keys:saved?.animationFrameKeys?.length};
  },original.id);
  expect(cache.frames).toBe(0);
  expect(cache.keys).toBe(original.frames);
  await page.getByRole("button",{name:"Explore airflow"}).click();
  await page.getByTestId("analysis-animation").click();
  await expect(page.getByLabel("Recorded section")).toHaveValue("top");
  await expect(page.getByRole("slider",{name:"Position",exact:true})).toHaveCount(0);
  const state=()=>page.evaluate(()=>{
    const s=(window as any).__easycfd.stages.main;
    return {dims:s.animationGPU[0].dims.toArray(),cut:s.slice.uniforms.uCutFace.value,opacity:s.slice.uniforms.uOpacity.value,smokeWidth:s.flowSmoke.dye.width,position:s.animationPosition()};
  });
  await page.getByRole("radio",{name:"Flowing smoke",exact:true}).click();
  await expect.poll(async()=>(await state()).smokeWidth).toBe(1536);
  expect((await state()).cut).toBe(false);
  await page.getByRole("button",{name:"Pause flow",exact:true}).click();
  await page.getByRole("slider",{name:"Animation time",exact:true}).fill("0.5");
  const paused=(await state()).position;
  await page.waitForTimeout(300);
  expect((await state()).position).toBeCloseTo(paused,4);
  await page.getByRole("button",{name:"Play flow",exact:true}).click();
  await page.waitForTimeout(400);
  expect((await state()).position).toBeGreaterThan(paused);
  await page.screenshot({path:"test-results/fine-top-playback.png"});
  for(const [section,axis] of [["upper",2],["wheels",1],["side",1]] as const) {
    await page.getByLabel("Recorded section").selectOption(section);
    await expect(page.getByLabel("Recorded section")).toBeEnabled({timeout:420000});
    const selected=await page.evaluate(()=>{
      const s=(window as any).__easycfd.app.get();
      return {section:s.run.animation.section,dims:s.run.animation.frames[0].field.dims,axis:s.viz.sliceAxis,result:JSON.stringify(s.run.doc.result)};
    });
    expect(selected.section).toBe(section);
    expect(selected.dims[axis]).toBe(1);
    expect(selected.axis).toBe(axis);
    expect(selected.result).toBe(original.result);
  }
  await page.screenshot({path:"test-results/fine-side-playback.png"});
  await page.reload();
  await page.route("**/api/**",route=>route.abort());
  await page.evaluate(async id=>{const {openRun}=await import("/src/store/runs.ts");await openRun(id);},original.id);
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().run.animation.section)).toBe("side");
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("button",{name:"Explore airflow"}).click();
  await page.getByTestId("analysis-animation").click();
  await page.getByRole("button",{name:"View settings"}).click();
  await expect(page.getByLabel("Recorded section")).toHaveValue("side");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:"test-results/fine-mobile-playback.png"});
  expect(errors).toEqual([]);
});
