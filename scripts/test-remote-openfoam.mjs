// Real Docker + browser smoke test. Build web/dist with VITE_ENABLE_OPENFOAM=false first.
// EASYCFD_REMOTE_URL is a server root (no token). Uses the Compose-generated token by default.
import { chromium, expect } from "../web/node_modules/@playwright/test/index.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const output = resolve(repo, process.env.EASYCFD_TEST_OUTPUT ?? "test-results/remote-openfoam");
await mkdir(output, {recursive:true});
const container = process.env.EASYCFD_TEST_CONTAINER ?? "easy-cfd-backend-1";
const token = process.env.EASYCFD_REMOTE_TOKEN ?? execFileSync("docker", ["exec",container,"python","-c",
  "import os; from pathlib import Path; print(os.environ.get('EASYCFD_API_TOKEN') or Path('/data/.api-token').read_text().strip())"], {encoding:"utf8"}).trim();
const backend = (process.env.EASYCFD_REMOTE_URL ?? "http://localhost:8000").replace(/\/$/, "");
const headers = {Authorization:`Bearer ${token}`,"ngrok-skip-browser-warning":"1"};
const evidence = {frontend:"https://easy-cfd.mthracelab.com",backend,nativeDiscovery:false,checks:{},requests:[],pageErrors:[],consoleErrors:[]};
// Docker may have opened its port before Python finishes starting the API.
for(let attempt=0;attempt<60;attempt++) {
  try {
    const response=await fetch(`${backend}/api/health`,{headers,signal:AbortSignal.timeout(4000)});
    if(response.status===200 || response.status===401) break;
    if(attempt===59) throw new Error(`Backend startup returned HTTP ${response.status}`);
  } catch(error) {if(attempt===59) throw error;}
  await new Promise(resolve=>setTimeout(resolve,250));
}
for (const [name,auth] of [["missing",{}],["incorrect",{Authorization:"Bearer incorrect"}],["correct",headers]]) {
  const response=await fetch(`${backend}/api/health`, {headers:{"ngrok-skip-browser-warning":"1",...auth}});
  evidence.checks[name]=response.status;
  if(response.status!==(name==="correct"?200:401)) throw new Error(`Unexpected ${name} token status: ${response.status}`);
}
const browser = await chromium.launch({headless:true,args:["--use-angle=swiftshader","--ignore-gpu-blocklist"]});
let page;
try {
  // Capture the actual Docker startup output, including the copyable connection URL.
  const startup=spawnSync("docker",["logs",container],{encoding:"utf8"});
  if(startup.status===0) {
    const terminal=await browser.newPage({viewport:{width:1500,height:680}});
    await terminal.setContent('<html><body style="margin:0;padding:36px;background:#101725;color:#e8edf7;font-family:monospace"><h1 style="font:600 25px system-ui;margin:0 0 24px">OpenFOAM backend · Docker startup</h1><pre style="font:17px/1.65 monospace;white-space:pre-wrap;margin:0"></pre></body></html>');
    await terminal.locator("pre").evaluate((el,text)=>el.textContent=text,`$ docker logs ${container}\n\n${startup.stdout}${startup.stderr}`);
    await terminal.screenshot({path:resolve(output,"backend-startup.png"),fullPage:true});
    await terminal.close();
  }
  const context = await browser.newContext({viewport:{width:1600,height:1000}});
  // Equivalent to the user accepting the browser's local network access prompt.
  if(backend.startsWith("http:")) await context.grantPermissions(["local-network-access"],{origin:evidence.frontend});
  page = await context.newPage();
  page.on("console",msg=>{if(msg.type()==="error") evidence.consoleErrors.push(msg.text());});
  page.on("pageerror",e=>evidence.pageErrors.push(e.message));
  page.on("request",req=> {
    if(req.url().startsWith(backend)) {
      if(req.url().includes("token=")) throw new Error("Token leaked into a request URL");
      evidence.requests.push({method:req.method(),path:new URL(req.url()).pathname});
    }
  });
  // Serve this checkout's production static build at the public HTTPS origin in the test browser.
  // API requests are real network requests to Docker, with browser CORS/mixed-content rules intact.
  await page.route("https://easy-cfd.mthracelab.com/**", async route => {
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith("/api")) throw new Error("Static frontend attempted native API discovery");
    const file=resolve(repo,"web/dist",pathname === "/"?"index.html":pathname.slice(1));
    if(!file.startsWith(resolve(repo,"web/dist")+"/")) return route.abort();
    const types={".html":"text/html",".js":"application/javascript",".css":"text/css",".md":"text/plain"};
    try {await route.fulfill({body:await readFile(file),contentType:types[extname(file)]??"application/octet-stream"});}
    catch {await route.fulfill({status:404,body:"Not found"});}
  });
  await page.goto("https://easy-cfd.mthracelab.com/");
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button",{name:"Continue to conditions"}).click();
  await page.getByRole("button",{name:"Continue to run"}).click();
  await page.getByText("OpenFOAM server connection",{exact:true}).click();
  await page.getByLabel("Remote backend URL with token").fill(`${backend}?token=${encodeURIComponent(token)}`);
  await page.getByRole("button",{name:"Connect remote server"}).click();
  await expect(page.getByTestId("engine-openfoam")).toBeEnabled({timeout:30000});
  await page.getByTestId("engine-openfoam").click();
  await page.getByRole("radio",{name:/^Fast/}).click();
  await page.getByLabel("Remote backend URL with token").scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,"connected.png"),fullPage:true});
  evidence.checks.httpsFrontendConnection="passed";
  if(process.env.EASYCFD_CONNECTION_ONLY === "true") {
    console.log("HTTPS static frontend connected to Docker at",backend);
    await writeFile(resolve(output,"localhost-connection.json"),JSON.stringify(evidence,null,2));
  } else {
    await page.getByTestId("run").click();
    await expect(page.locator(".live-head h2")).toBeVisible({timeout:30000});
    await page.screenshot({path:resolve(output,"running.png"),fullPage:true});
    console.log("Fast simulation started through",backend);
    await expect(page.getByTestId("result-engine")).toHaveText("OpenFOAM",{timeout:360000});
    await expect(page.getByTestId("card-cd")).toBeVisible();
    await page.screenshot({path:resolve(output,"results.png"),fullPage:true});
    const runs=await (await fetch(`${backend}/api/runs`,{headers})).json();
    const run=runs.find(r=>r.status==="completed");
    if(!run) throw new Error("No completed run saved by the backend");
    evidence.run={id:run.id,status:run.status,started:run.started,finished:run.finished,quality:run.settings.quality,result:run.result};
    await writeFile(resolve(output,"verification.json"),JSON.stringify(evidence,null,2));
    const logs=spawnSync("docker",["logs",container],{encoding:"utf8"});
    await writeFile(resolve(output,"backend.log"),logs.stdout+logs.stderr);
    console.log("Fast simulation completed:",run.id,"Cd",run.result.cd,"Cl",run.result.cl);
    await page.reload();
    await page.getByTestId("open-library").click();
    await page.getByTestId("run-item").first().click();
    await expect(page.getByTestId("result-engine")).toHaveText("OpenFOAM");
    evidence.checks.reopen="passed";
    await writeFile(resolve(output,"verification.json"),JSON.stringify(evidence,null,2));
  }
  if(evidence.pageErrors.length) throw new Error(evidence.pageErrors.join("\n"));
} catch(error) {
  await page?.getByLabel("Remote backend URL with token").fill("").catch(()=>{});
  await page?.screenshot({path:resolve(output,"failure.png"),fullPage:true}).catch(()=>{});
  await writeFile(resolve(output,"failure.json"),JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
