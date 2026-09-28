// Renders solver field slices to PNG for inspection: node validation/slices.mjs <model> <quality> <passes>
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const runs = resolve(root, "../.easycfd/runs");
const [modelId = "sample", quality = "fast", passes = "4"] = process.argv.slice(2);
const extra = process.env.SETTINGS ? JSON.parse(process.env.SETTINGS) : {};
const spec = JSON.parse(readFileSync(resolve(here, "models.json"), "utf8"));
const model = spec.models.find((m) => m.id === modelId);

function png(w, h, rgb) {
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ramp = (t) => { // blue-white-red
  t = Math.max(0, Math.min(1, t));
  const s = [[0.1, 0.2, 0.7], [0.3, 0.7, 0.95], [1, 1, 1], [0.98, 0.7, 0.3], [0.75, 0.1, 0.1]];
  const f = t * 4, i = Math.min(3, Math.floor(f)), u = f - i;
  return s[i].map((a, c) => Math.round(255 * (a + (s[i + 1][c] - a) * u)));
};
const server = await createServer({ root, server: { port: 5197, host: "127.0.0.1", hmr: false, watch: null }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
await page.route("**/geom/**", (route) => route.fulfill({ body: readFileSync(resolve(runs, decodeURIComponent(new URL(route.request().url()).pathname.split("/geom/")[1]))) }));
await page.goto("http://127.0.0.1:5197/bench.html");
await page.waitForFunction(() => window.cfdBench?.ready);
const body = {
  parts: model.parts.map((p) => ({ url: `/geom/${model.geometryRun}/geometry/${p.file}`, name: p.name, role: p.role, wheel: p.wheel, active: p.active, detail: p.detail })),
  settings: { ...model.settings, quality, ...extra }, targetPasses: Number(passes),
};
const zmid = model.dimensions[2] * 0.3;
const planeList = process.env.PLANES ? JSON.parse(process.env.PLANES) : [{ axis: "y", at: 0 }, { axis: "z", at: zmid }, { axis: "y", at: 1.05 * model.dimensions[1] / 2.34 }];
const out = await page.evaluate((b) => window.cfdBench.slices(b[0], b[1]), [body, planeList]);
const dir = resolve(here, "results", "slices");
mkdirSync(dir, { recursive: true });
const U = model.settings.speed_kmh / 3.6;
const ranges = { speed: [0, 1.4 * U], p: [-0.8 * U * U, 0.5 * U * U], nut: [0, null], k: [0, null], w: [-0.3 * U, 0.3 * U] };
for (const pl of out.planes) {
  for (const [name, vals] of Object.entries(pl.fields)) {
    if (name === "solid") continue;
    let [lo, hi] = ranges[name];
    if (hi === null) hi = Math.max(...vals.filter(Number.isFinite)) || 1;
    const scale = 3;
    const W = pl.width * scale, H = pl.height * scale;
    const rgb = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = vals[(pl.height - 1 - Math.floor(y / scale)) * pl.width + Math.floor(x / scale)];
      const c = Number.isFinite(v) ? ramp((v - lo) / (hi - lo)) : [40, 40, 40];
      rgb.set(c, (y * W + x) * 3);
    }
    writeFileSync(resolve(dir, `${modelId}-${pl.axis}${pl.at.toFixed(2)}-${name}.png`), png(W, H, rgb));
  }
}
writeFileSync(resolve(dir, `${modelId}-planes.json`), JSON.stringify(out));
console.log(JSON.stringify({ cd: out.cd, cl: out.cl, breakdown: out.breakdown }));
console.log("history", out.history.map((h) => `${h.time.toFixed(2)}:${h.cd.toFixed(3)}/${h.cl.toFixed(3)}`).join(" "));
await browser.close();
await server.close();
