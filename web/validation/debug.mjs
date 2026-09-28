import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const runs = resolve(root, "../.easycfd/runs");
const [modelId = "sample", steps = "5", quality = "fast", vc = "2"] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(resolve(here, "models.json"), "utf8"));
const model = spec.models.find((m) => m.id === modelId);
const server = await createServer({ root, server: { port: 5198, host: "127.0.0.1", hmr: false, watch: null }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[page]", m.text()); });
await page.route("**/geom/**", (route) => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.split("/geom/")[1]);
  route.fulfill({ body: readFileSync(resolve(runs, rel)) });
});
await page.goto("http://127.0.0.1:5198/bench.html");
await page.waitForFunction(() => window.cfdBench?.ready);
const body = {
  parts: model.parts.map((p) => ({ url: `/geom/${model.geometryRun}/geometry/${p.file}`, name: p.name, role: p.role, wheel: p.wheel })),
  settings: { ...model.settings, quality },
};
const PROBE_ARG = process.env.PROBE ? JSON.parse(process.env.PROBE) : undefined;
const out = process.env.DTLIM
  ? [await page.evaluate(([b, n]) => window.cfdBench.dtLimiters(b, n), [body, Number(steps)])]
  : process.env.CELLS
  ? [await page.evaluate(([b, c]) => window.cfdBench.cellInfo(b, c), [body, JSON.parse(process.env.CELLS)])]
  : process.env.PERF
  ? [await page.evaluate(([b, s, o]) => window.cfdBench.perf(b, s, o), [body, Number(steps), JSON.parse(process.env.PERF)])]
  : process.env.MG
  ? [await page.evaluate(([b, s, o]) => window.cfdBench.mg(b, s, o), [body, Number(steps), JSON.parse(process.env.MG)])]
  : await page.evaluate(([b, s, v, pr]) => window.cfdBench.debug(b, s, { vcycles: v, probe: pr }), [body, Number(steps), Number(vc), PROBE_ARG]);
for (const o of out) console.log(JSON.stringify(o));
await browser.close();
await server.close();
