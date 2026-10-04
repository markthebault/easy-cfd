// Runs the browser solver on every validation model in headless Chromium (WebGPU) and compares
// with the OpenFOAM references in models.json. Usage:
//   node validation/run-validation.mjs [--models sample,mx5] [--quality medium] [--passes 14]
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const runs = resolve(root, "../.easycfd/runs");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const spec = JSON.parse(readFileSync(resolve(here, "models.json"), "utf8"));
const wanted = args.models ? args.models.split(",") : spec.models.map((m) => m.id);
const quality = args.quality ?? "medium";
const extra = args.settings ? JSON.parse(args.settings) : {};

const server = await createServer({ root, server: { port: Number(args.port ?? 5199), host: "127.0.0.1", hmr: false, watch: null }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.route("**/geom/**", (route) => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.split("/geom/")[1]);
  route.fulfill({ body: readFileSync(resolve(runs, rel)), contentType: "application/octet-stream" });
});
const backend=args.backend ?? process.env.EASYCFD_VALIDATION_BACKEND;
if(backend) await page.route("**/api/compute-lease**",async route=>{
  const req=route.request(),u=new URL(req.url());
  const response=await page.request.fetch(`${backend}${u.pathname}`,{method:req.method(),data:req.postDataBuffer()??undefined,headers:req.headers()});
  await route.fulfill({response});
});
await page.goto(`http://127.0.0.1:${args.port ?? 5199}/bench.html`);
await page.waitForFunction(() => window.cfdBench?.ready, null, { timeout: 60000 });
await page.evaluate(enabled=>{window.cfdBenchBackend=enabled;},!!backend);

const results = [];
for (const model of spec.models.filter((m) => wanted.includes(m.id))) {
  const body = {
    parts: model.parts.map((p) => ({ url: `/geom/${model.geometryRun}/geometry/${p.file}`, name: p.name, role: p.role, wheel: p.wheel, active: p.active, detail: p.detail })),
    settings: { ...model.settings, quality, ...extra },
    targetPasses: args.passes ? Number(args.passes) : undefined,
    solver: args.solver ? JSON.parse(args.solver) : undefined,
    lts: args.lts ? args.lts === "1" : undefined,
    ltsMaxFactor: args.ltsmax ? Number(args.ltsmax) : undefined,
  };
  const t0 = Date.now();
  const logHandle = setInterval(async () => {
    const txt = await page.evaluate(() => document.getElementById("log").textContent.split("\n").slice(-1)[0]).catch(() => "");
    console.log(`  ${model.id}: ${txt}`);
  }, 15000);
  let r;
  try {
    r = await page.evaluate((b) => window.cfdBench.run(b), body);
  } catch (e) {
    clearInterval(logHandle);
    console.log(`${model.id}: FAILED ${e.message}`);
    results.push({ id: model.id, error: e.message });
    continue;
  }
  clearInterval(logHandle);
  const ref = model.references.find((x) => x.quality === "medium") ?? model.references[0];
  const dCd = ref ? (r.cd - ref.cd) / ref.cd : NaN;
  const dCl = ref ? r.cl - ref.cl : NaN;
  const refText = ref ? `(ref ${ref.cd.toFixed(4)} ${ref.quality}, ${(dCd * 100).toFixed(1)}%)` : "(no reference)";
  const line = `${model.id.padEnd(12)} cd ${r.cd.toFixed(4)} ${refText}  cl ${r.cl.toFixed(4)}${ref ? ` (ref ${ref.cl.toFixed(4)}, Δ ${dCl.toFixed(3)})` : ""}  cells ${r.cells} steps ${r.steps} ${((Date.now() - t0) / 1000).toFixed(0)} s settled=${r.settled} detail=${r.detail?.ratio} thin=[${(r.thinParts ?? []).join(",")}]`;
  for (const f of r.partForces ?? []) if (!/body|wheel/.test(f.name)) console.log(`    ${f.name.padEnd(22)} drag ${(f.pressure[0] + f.friction[0]).toFixed(1)} N  lift ${(f.pressure[2] + f.friction[2]).toFixed(1)} N`);
  console.log(line);
  results.push({ id: model.id, name: model.name, reference: ref, dCd, dCl, result: r });
}
mkdirSync(resolve(here, "results"), { recursive: true });
const out = resolve(here, "results", `validation-${quality}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ quality, extra, results }, null, 1));
console.log("saved", out);
await browser.close();
await server.close();
