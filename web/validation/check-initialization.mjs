// Real-device regression checks. No CFD steps or external geometry fixtures are required.
// node validation/check-initialization.mjs [--revision <git revision>] [--output <json>]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const argument = name => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const revision = argument("--revision");
const plugins = revision ? [{
  name: "committed-initialization-check",
  enforce: "pre",
  load(id) {
    const path = id.split("?")[0];
    if (!path.startsWith(`${root}/src/`) || !/\.tsx?$/.test(path)) return null;
    return execFileSync("git", ["show", `${revision}:${relative(repo, path)}`], { cwd: repo, encoding: "utf8" });
  },
}] : [];
const server = await createServer({ root, plugins, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" });
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.route("**/initialization-check.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Solver initialization check</title>" }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/initialization-check.html`);
  for (const mode of ["healthy", "invalid-shader", "synchronous-failure", "buffer-upload-failure"]) {
    results.push(await page.evaluate(async mode => {
      const { requestDevice } = await import("/src/solver/gpu.ts");
      const { runSimulation } = await import("/src/solver/run.ts");
      const { sampleCar } = await import("/src/geometry/sample.ts");
      const { DEFAULT_SETTINGS } = await import("/src/solver/types.ts");
      const info = await requestDevice();
      const allocated = new Set(), destroyed = new Set();
      let scopeDepth = 0, submissions = 0;
      const actual = info.device;
      const queue = new Proxy(actual.queue, { get(target, key) {
        if (key === "submit") return commands => { submissions++; return target.submit(commands); };
        if (key === "writeBuffer" && mode === "buffer-upload-failure") return () => { throw new Error("Injected synchronous buffer upload failure"); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const device = new Proxy(actual, { get(target, key) {
        if (key === "queue") return queue;
        if (key === "pushErrorScope") return filter => { scopeDepth++; target.pushErrorScope(filter); };
        if (key === "popErrorScope") return () => { scopeDepth--; return target.popErrorScope(); };
        if (key === "createBuffer") return descriptor => {
          const buffer = target.createBuffer(descriptor);
          const destroy = buffer.destroy.bind(buffer);
          buffer.destroy = () => { destroyed.add(buffer); destroy(); };
          allocated.add(buffer);
          return buffer;
        };
        if (key === "createShaderModule") return descriptor => {
          if (descriptor.label === "momentum" && mode === "synchronous-failure") throw new Error("Injected synchronous shader construction failure");
          return target.createShaderModule({ ...descriptor, code: descriptor.label === "momentum" && mode === "invalid-shader" ? "invalid WGSL for initialization regression" : descriptor.code });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const controller = new AbortController();
      controller.abort();
      let error, producedResult = false;
      try {
        await runSimulation(device, sampleCar(false), { ...DEFAULT_SETTINGS, quality: "custom", custom_cells: 12, custom_passes: 1 }, { signal: controller.signal });
        producedResult = true;
      } catch (caught) {
        error = { name: caught.name, message: caught.message };
      } finally {
        actual.destroy();
      }
      return { mode, adapter: info.adapterName, software: info.software, scopeDepth, submissions, allocated: allocated.size, destroyed: destroyed.size, producedResult, error, fluidSteps: 0 };
    }, mode));
  }
} finally {
  await browser?.close();
  await server.close();
}
const failures = [];
for (const result of results) {
  try {
    assert.equal(result.software, false, "hardware WebGPU required");
    assert.equal(result.producedResult, false, "initialization checks must not produce aerodynamic results");
    assert.equal(result.scopeDepth, 0, "error scopes must be balanced");
    assert.ok(result.allocated > 0);
    assert.equal(result.destroyed, result.allocated, "all solver buffers must be released");
    if (result.mode === "healthy") {
      assert.equal(result.error?.name, "AbortError", "valid kernels must reach the cancellation check");
      assert.ok(result.submissions > 0, "valid initialization must reach the initial projection");
    } else {
      assert.equal(result.submissions, 0, "failed initialization must stop before projection");
      const message = result.mode === "invalid-shader" ? /^GPU solver initialization:/
        : result.mode === "buffer-upload-failure" ? /Injected synchronous buffer upload failure/ : /Injected synchronous shader construction failure/;
      assert.match(result.error?.message ?? "", message);
    }
  } catch (error) {
    failures.push({ mode: result.mode, message: error.message });
  }
}
const sourceHashes = Object.fromEntries(["web/src/solver/run.ts", "web/src/solver/gpu.ts"].map(path => [path,
  createHash("sha256").update(revision ? execFileSync("git", ["show", `${revision}:${path}`], { cwd: repo }) : readFileSync(resolve(repo, path))).digest("hex"),
]));
const record = { checkedUTC: new Date().toISOString(), revision: revision ?? "working tree", sourceHashes, results, failures, passed: failures.length === 0 };
if (argument("--output")) {
  const output = resolve(repo, argument("--output"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
}
for (const result of results) console.log(`${result.mode}: ${result.adapter}, buffers ${result.destroyed}/${result.allocated}, submissions ${result.submissions}, ${result.error?.name}`);
for (const failure of failures) console.error(`${failure.mode}: ${failure.message}`);
if (failures.length) process.exitCode = 1;
