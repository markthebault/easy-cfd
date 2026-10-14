// Real production UI, static file server only, no WebGPU and no API requests.
import { chromium, expect } from "../web/node_modules/@playwright/test/index.mjs";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {cpus,totalmem} from "node:os";

const repo=resolve(dirname(fileURLToPath(import.meta.url)),".."),dist=resolve(repo,"web/dist");
const output=resolve(repo,process.env.EASYCFD_WASM_OUTPUT ?? "test-results/browser-openfoam");
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
  if(!["GET","HEAD"].includes(req.method)){res.writeHead(405);res.end();return;}
  const file=resolve(dist,path==="/"?"index.html":path.slice(1));
  if(!file.startsWith(dist+"/")){res.writeHead(403);res.end();return;}
  try{const data=await readFile(file);res.writeHead(200,{"Content-Type":{".html":"text/html",".js":"application/javascript",".css":"text/css",".json":"application/json"}[extname(file)] ?? "application/octet-stream"});res.end(data);}
  catch{res.writeHead(404);res.end("Not found");}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const startUrl=new URL(process.env.EASYCFD_WASM_BASE_URL ?? `http://127.0.0.1:${server.address().port}`);
const origin=startUrl.origin;
const browser=await chromium.launch({headless:true,args:process.platform === "darwin"?["--use-angle=metal","--enable-gpu","--ignore-gpu-blocklist"]:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const models=(process.env.EASYCFD_WASM_MODELS ?? "sample,sample-fast").split(",");
const evidence={base:"origin/main",runtime:"static files + browser WebAssembly",webgpu:false,
  environment:{platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,cores:cpus().length,memoryGB:totalmem()/1024**3},apiRequests:[],runs:[],checks:{}};

try{
  for(const model of models){
    const dir=join(output,model);await mkdir(dir,{recursive:true});
    const context=await browser.newContext({viewport:{width:1440,height:960},recordVideo:{dir,size:{width:1440,height:960}},reducedMotion:"reduce"});
    await context.addInitScript(()=>{
      window.__gpuReads=0;
      Object.defineProperty(navigator,"gpu",{configurable:true,get(){window.__gpuReads++;return undefined;}});
      // Capture the real worker's case files for a native parity test, without app test hooks.
      const Original=window.Worker;
      window.Worker=class extends Original {
        constructor(...args){super(...args);let lastLabel="",lastIteration=0;this.addEventListener("message",event=>{
          if(event.data.type==="done"){window.__wasmOutcome=event.data.value;}
          if(event.data.type==="error"){window.__wasmError=event.data.message;window.__wasmFailure=event.data;}
          if(event.data.type==="progress"){
            const p=event.data.value;
            if(p.label!==lastLabel || p.iteration-lastIteration>=100){
              console.info(`OpenFOAM progress: ${p.label}, ${p.iteration}/${p.iterations} iterations, ${p.cells} cells`);
              lastLabel=p.label;lastIteration=p.iteration;
            }
          }
        });}
        postMessage(value,...args){if(value?.parts && value?.settings)value.includeCaseFiles=true;return super.postMessage(value,...args);}
      };
    });
    const page=await context.newPage(),errors=[],requests=[];
    page.on("console",m=>{if(m.type()==="info" && m.text().startsWith("OpenFOAM progress:"))console.log(`${model}: ${m.text()}`);});
    page.on("pageerror",e=>errors.push(e.message));
    page.on("request",r=>requests.push({method:r.method(),url:r.url()}));
    await context.route(/https?:\/\//,route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin || url.pathname.startsWith("/api/")){
        evidence.apiRequests.push(route.request().url());return route.abort();
      }
      return route.continue();
    });
    await page.goto(startUrl.href);
    let settings;
    if(model.startsWith("sample")){
      if(model.includes("wing"))await page.getByRole("switch",{name:"with rear wing"}).check();
      await page.getByTestId("try-sample").click();
    }else{
      const root=join(repo,".wasm-test-models",model.replace(/-(fast|detailed)$/,"")),record=JSON.parse(await readFile(join(root,"record.json"),"utf8"));
      settings=record.settings;
      const geom=(await readdir(root)).find(n=>n.startsWith("geometry-"));
      const parts=record.geometry.parts.filter(p=>p.enabled!==false);
      const files=await Promise.all(parts.map(async(p,i)=>({name:`${String(i).padStart(2,"0")}-${p.name.replace(/[^\w-]/g,"_")}.stl`,mimeType:"model/stl",buffer:await readFile(join(root,geom,p.id+".stl"))})));
      await page.locator("input[type=file]").first().setInputFiles(files);
      await page.getByLabel("Nose direction in the file").selectOption("-X");
      await page.getByLabel("Up direction in the file").selectOption("+Z");
      await expect(page.locator(".busy")).toHaveCount(0,{timeout:60000});
    }
    await page.getByText("I checked size, orientation, wheels and clearance.").click();
    await page.getByRole("button",{name:"Continue to conditions"}).click();
    if(settings){
      for(const [name,value] of [["Reference area",settings.reference_area],["Air density",settings.density]]){
        await page.getByRole("textbox",{name,exact:true}).fill(String(value));
        await page.getByRole("textbox",{name,exact:true}).press("Enter");
      }
      await page.getByRole("checkbox",{name:"Moving road",exact:true}).setChecked(settings.moving_ground);
      await page.getByRole("checkbox",{name:"Rotating wheels",exact:true}).setChecked(settings.wheels);
    }
    await page.getByRole("button",{name:"Continue to run"}).click();
    await expect(page.getByTestId("engine-wasm")).toHaveAttribute("aria-checked","true");
    await expect(page.getByTestId("engine-openfoam")).toBeDisabled();
    const quality=process.env.EASYCFD_WASM_QUALITY ?? (model.endsWith("-detailed")?"precise":model.endsWith("-fast")?"medium":"fast");
    assert.ok(["fast","medium","precise"].includes(quality),"Unknown browser quality preset");
    const qualityLabel={fast:"Quick",medium:"Fast",precise:"Detailed"}[quality];
    await page.getByTestId(`wasm-quality-${quality}`).click();
    await expect(page.getByTestId(`wasm-quality-${quality}`)).toHaveAttribute("aria-checked","true");
    const timeLimit=Number(await page.locator("#elapsed-limit").inputValue());
    await page.screenshot({path:join(dir,"setup.png")});
    const started=Date.now();console.log(`${model}: starting browser OpenFOAM`);
    await page.getByTestId("run").click();
    await expect(page.locator(".live-head h2")).toBeVisible();
    await page.screenshot({path:join(dir,"running.png")});
    await page.waitForFunction(()=>window.__wasmOutcome || window.__wasmError,{},{timeout:(timeLimit+50)*1000});
    const failure=await page.evaluate(()=>window.__wasmError);
    if(failure){
      await writeFile(join(dir,"failure.json"),JSON.stringify({model,error:failure},null,2));
      await writeFile(join(dir,"solver.log"),await page.evaluate(()=>window.__wasmFailure.log ?? ""));
      const failedDir=join(dir,"failed-case");await mkdir(failedDir,{recursive:true});
      await page.exposeFunction("saveFailedFile",async(path,b64)=>{const file=resolve(failedDir,path);assert.ok(file.startsWith(failedDir+"/"));await mkdir(dirname(file),{recursive:true});await writeFile(file,Buffer.from(b64,"base64"));});
      await page.evaluate(async()=>{for(const [path,a] of Object.entries(window.__wasmFailure.caseFiles ?? {})){let t="";for(let i=0;i<a.length;i+=16384)t+=String.fromCharCode(...a.subarray(i,i+16384));await window.saveFailedFile(path,btoa(t));}});
      throw new Error(`${model}: ${failure}`);
    }
    await expect(page.getByTestId("result-engine")).toHaveText("OpenFOAM · Browser",{timeout:60000});
    await expect(page.locator(".results-head")).toContainText(`${qualityLabel} · Browser`);
    const measured=await page.evaluate(()=>{
      const {result,field,surface,log}=window.__wasmOutcome;
      const minmax=a=>{let min=Infinity,max=-Infinity,finite=0;for(const v of a)if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);finite++;}return {min,max,finite,total:a.length};};
      return {result,field:{dims:field.dims,u:minmax(field.u),p:minmax(field.p),valid:field.solid.reduce((n,v)=>n+!v,0)},
        surface:surface.map(s=>({cp:minmax(s.cp),stressPoints:s.stressValid.reduce((n,v)=>n+v,0)})),log,gpuReads:window.__gpuReads};
    });
    assert.equal(measured.gpuReads,0,"App accessed WebGPU");assert.equal(measured.result.openfoam.runtime,"wasm");
    assert.equal(measured.result.engine,"openfoam");assert.ok(measured.result.cd>0 && measured.result.cd<5);
    if(quality==="precise"){assert.equal(measured.result.steps,1000);assert.ok(measured.result.cells<=600000);}
    assert.ok(measured.field.p.max-measured.field.p.min>1);assert.ok(measured.field.u.max-measured.field.u.min>1);
    assert.ok(measured.field.valid>1000);assert.ok(measured.surface.every(s=>s.cp.finite>0));assert.equal(measured.result.history.length,measured.result.steps);
    await writeFile(join(dir,"solver.log"),measured.log);delete measured.log;
    measured.elapsedSeconds=(Date.now()-started)/1000;
    measured.quality=quality;measured.timeLimitSeconds=timeLimit;
    await writeFile(join(dir,"verification.json"),JSON.stringify(measured,null,2));
    await page.screenshot({path:join(dir,"results.png")});
    const saveCase=join(dir,"case");await mkdir(saveCase,{recursive:true});
    await page.exposeFunction("saveCaseFile",async(path,b64)=>{
      const file=resolve(saveCase,path);assert.ok(file.startsWith(saveCase+"/"));await mkdir(dirname(file),{recursive:true});await writeFile(file,Buffer.from(b64,"base64"));
    });
    await page.evaluate(async()=>{
      for(const [path,a] of Object.entries(window.__wasmOutcome.caseFiles)){
        let text="";for(let i=0;i<a.length;i+=16384)text+=String.fromCharCode(...a.subarray(i,i+16384));
        await window.saveCaseFile(path,btoa(text));
      }
      delete window.__wasmOutcome;
    });
    for(const preset of ["Side","Top","3D"]){await page.getByRole("button",{name:preset,exact:true}).click({force:true});await page.waitForTimeout(700);}
    for(const layer of ["streamlines","slice"]){const btn=page.getByTestId(`layer-${layer}`);await btn.click();await page.waitForTimeout(2000);await page.screenshot({path:join(dir,`${layer}.png`)});await btn.click();}
    await page.reload();
    await page.getByTestId("open-library").click();
    await page.getByTestId("run-item").first().click();
    await expect(page.getByTestId("result-engine")).toHaveText("OpenFOAM · Browser");
    await expect(page.locator(".results-head")).toContainText(`${qualityLabel} · Browser`);
    await page.screenshot({path:join(dir,"reopened.png")});
    assert.deepEqual(errors,[],"Browser errors");
    const video=page.video();await context.close();const old=await video.path();
    await video.saveAs(join(dir,"browser-openfoam.webm"));
    evidence.runs.push({model,...measured,requests,video:join(dir,"browser-openfoam.webm"),reopen:"passed"});
    await writeFile(join(output,"verification.json"),JSON.stringify(evidence,null,2));
    console.log(`${model}: ${measured.result.cells} cells, ${measured.result.steps} iterations, Cd=${measured.result.cd.toFixed(5)}, ${measured.elapsedSeconds.toFixed(1)} seconds; video ${old}`);
  }
  assert.deepEqual(evidence.apiRequests,[]);
  evidence.checks={staticOnly:"passed",noApi:"passed",noWebGPU:"passed",computedFields:"passed",savedReopen:"passed"};
  await writeFile(join(output,"verification.json"),JSON.stringify(evidence,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
