// Resumable, bounded numerical experiments. Each attempted model solve counts as one iteration.
// node validation/run-accuracy.mjs --plan ../../.../plan.json
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { comparison, LIMIT, TOLERANCE } from "./accuracy-metrics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)),"..");
const repository = resolve(root,"..");
const args = Object.fromEntries(process.argv.slice(2).flatMap((a,i,all)=>a.startsWith("--")?[[a.slice(2),all[i+1]]]:[]));
const limit = Number(args.limit ?? LIMIT), tolerance = Number(args.tolerance ?? TOLERANCE);
if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT) throw new Error("Trial limit must be an integer from 1 to 100");
if (!(tolerance > 0 && tolerance < 1)) throw new Error("Tolerance must be between zero and one");
const evidence = resolve(repository,args.output ?? "docs/webgpu-accuracy");
const geometryRoot = resolve(args.runs ?? join(repository,".easycfd/runs"));
const modelSpec = JSON.parse(readFileSync(join(root,"validation/models.json"),"utf8"));
const plan = JSON.parse(readFileSync(resolve(args.plan),"utf8"));
mkdirSync(join(evidence,"iterations"),{recursive:true});
const lockPath = join(evidence,"campaign.lock");
const lock = openSync(lockPath,"wx");
writeFileSync(lock,String(process.pid));
let server, browser;
const atomic = (file,value) => {writeFileSync(file+".tmp",JSON.stringify(value,null,2)+"\n");renameSync(file+".tmp",file);};
const sourceRevision = execFileSync("git",["rev-parse","--verify",args.revision ?? "HEAD"],{cwd:repository,encoding:"utf8"}).trim();
const sourcePaths = execFileSync("git",["ls-tree","-r","--name-only",sourceRevision,"web/src"],{cwd:repository,encoding:"utf8"}).trim().split("\n").filter(file=>/\.tsx?$/.test(file));
const frozenSources = new Map(sourcePaths.map(file=>[join(repository,file),execFileSync("git",["show",`${sourceRevision}:${file}`],{cwd:repository,encoding:"utf8"})]));
try {
  const manifestFile = join(evidence,"campaign.json");
  try {
    const previous = JSON.parse(readFileSync(manifestFile,"utf8"));
    if (previous.limit !== limit || previous.tolerance !== tolerance) throw new Error("Campaign limit and tolerance are immutable; use a separate output folder for a new campaign");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    atomic(manifestFile,{limit,tolerance,created:new Date().toISOString()});
  }
  server = await createServer({root,plugins:[{name:"accuracy-source-snapshot",enforce:"pre",load(id){return frozenSources.get(id.split("?")[0]) ?? null;}}],server:{port:Number(args.port ?? 5201),host:"127.0.0.1",strictPort:true,hmr:false,watch:null},logLevel:"error"});
  await server.listen();
  browser = await chromium.launch({headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--enable-gpu","--ignore-gpu-blocklist"]});
  const page = await browser.newPage();
  page.on("pageerror",e=>console.log("[page]",e.message));
  await page.route("**/geom/**",route=>{
    const rel=decodeURIComponent(new URL(route.request().url()).pathname.split("/geom/")[1]);
    const file=resolve(geometryRoot,rel);
    if (!file.startsWith(geometryRoot+"/")) throw new Error("Geometry path escapes run directory");
    return route.fulfill({body:readFileSync(file),contentType:"application/octet-stream"});
  });
  if (args["validate-only"] === "true") {
    const validations=[];
    for (const trial of plan) {
      const model=modelSpec.models.find(m=>m.id===trial.model);
      const spec={parts:model.parts.map(p=>({...p,url:`/geom/${model.geometryRun}/geometry/${p.file}`})),settings:{...model.settings,quality:"custom",custom_cells:36,...trial.settings},solver:trial.solver};
      server.moduleGraph.invalidateAll();
      await page.goto(`http://127.0.0.1:${args.port ?? 5201}/bench.html`);
      await page.waitForFunction(()=>window.cfdBench?.ready,null,{timeout:60000});
      const validation=await page.evaluate(body=>window.cfdBench.compile(body),spec);
      validations.push({key:trial.key,settings:spec.settings,...validation});
      console.log(`Validated kernels: ${trial.key}, ${validation.adapter}, no fluid steps`);
    }
    atomic(join(evidence,"kernel-validation.json"),{sourceRevision,validated:new Date().toISOString(),validations,fluidSteps:0});
  } else {
  let records = readdirSync(join(evidence,"iterations")).filter(p=>/^\d{3}\.json$/.test(p)).sort().map(p=>JSON.parse(readFileSync(join(evidence,"iterations",p),"utf8")));
  const seen = new Set(records.map(r=>r.key));
  for (const trial of plan) {
    if (seen.has(trial.key)) continue;
    if (records.length >= limit) {console.log(`Stopped at the ${limit}-iteration limit.`);break;}
    const model=modelSpec.models.find(m=>m.id===trial.model);
    if (!model) throw new Error(`Unknown model ${trial.model}`);
    const settings={...model.settings,quality:"custom",custom_cells:36,custom_passes:12,max_seconds:1200,...trial.settings};
    const referenceFile=join(evidence,"references.json");
    let references={};try {references=JSON.parse(readFileSync(referenceFile,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
    const reference=references[model.id] ?? null;
    const source=createHash("sha256");for(const [file,contents] of frozenSources)source.update(file.replace(root,"")),source.update(contents);
    const spec={parts:model.parts.map(p=>({...p,url:`/geom/${model.geometryRun}/geometry/${p.file}`})),settings,lts:trial.lts,ltsMaxFactor:trial.ltsMaxFactor,solver:trial.solver,maxExtension:trial.maxExtension,probeWake:true};
    const iteration=records.length+1, file=join(evidence,"iterations",String(iteration).padStart(3,"0")+".json");
    const record={iteration,key:trial.key,model:model.id,hypothesis:trial.hypothesis,source:source.digest("hex"),sourceSnapshot:true,sourceRevision,started:new Date().toISOString(),status:"running",settings,reference,inputs:model.parts.map(p=>({file:`${model.geometryRun}/geometry/${p.file}`,sha256:createHash("sha256").update(readFileSync(join(geometryRoot,model.geometryRun,"geometry",p.file))).digest("hex")})),spec};
    atomic(file,record);records.push(record);seen.add(trial.key);
    console.log(`Iteration ${iteration}/${limit}: ${trial.key}`);
    let progress;
    try {
      // New document/device for every trial, so changed kernels and prior state cannot leak.
      server.moduleGraph.invalidateAll();
      await page.goto(`http://127.0.0.1:${args.port ?? 5201}/bench.html`);
      await page.waitForFunction(()=>window.cfdBench?.ready,null,{timeout:60000});
      progress=setInterval(async()=>{const value=await page.evaluate(()=>document.getElementById("log")?.textContent.split("\n").at(-1)).catch(()=>"");console.log(`  ${trial.key}: ${value}`);},20000);
      record.result=await page.evaluate(body=>window.cfdBench.run(body),spec);
      if (/swiftshader|software|llvmpipe/i.test(record.result.adapter)) throw new Error("Hardware WebGPU adapter required for this campaign");
      record.comparison=comparison(record.result,reference,tolerance);record.status="completed";
      console.log(`  ${record.result.cells} cells, Cd ${record.result.cd.toFixed(5)}, Cl ${record.result.cl.toFixed(5)}, ${record.result.wallSeconds.toFixed(1)} s; errors ${((record.comparison.cdError??Infinity)*100).toFixed(1)}%, ${((record.comparison.clError??Infinity)*100).toFixed(1)}%`);
    } catch(e) {record.status="failed";record.error=String(e.stack??e);console.log(`  FAILED: ${e.message}`);}
    finally {clearInterval(progress);record.finished=new Date().toISOString();atomic(file,record);atomic(join(evidence,"summary.json"),{limit,tolerance,attempts:records.length,complete:records.filter(r=>r.status==="completed").length,records:records.map(r=>({iteration:r.iteration,key:r.key,model:r.model,status:r.status,cells:r.result?.cells,cd:r.result?.cd,cl:r.result?.cl,comparison:r.comparison,error:r.error}))});}
    if(record.status==="failed" && /GPU solver initialization|Binding doesn't exist|shader/i.test(record.error ?? "")) {console.log("Stopped after kernel initialization failure; fix and validate before resuming.");break;}
    if(record.comparison?.qualified && plan.every(t=>seen.has(t.key))) console.log("Plan completed; suite-wide qualification still requires the report gates.");
  }
  }
} finally {await browser?.close();await server?.close();closeSync(lock);unlinkSync(lockPath);}
