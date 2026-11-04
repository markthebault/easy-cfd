import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function sourceFiles(path) {
  const entries = await readdir(path, {withFileTypes: true});
  const lists = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(path, entry.name)) : [join(path, entry.name)]));
  return lists.flat();
}

test("3D source has no retired compute API, shaders or solver entrypoints", async () => {
  const files = await sourceFiles(join(root, "src"));
  const forbidden = /webgpu|wgsl|GPUDevice|GPUBuffer|GPUAdapter|navigator\.gpu|FlowSolver/i;
  // The independent 2D workspace intentionally uses jax-js WebGPU/WASM.
  // Keep the retired 3D solver guard intact everywhere outside that directory.
  for (const file of files.filter(file => !file.startsWith(join(root, "src", "flow2d") + "/")))
    assert.doesNotMatch(await readFile(file, "utf8"), forbidden, file);
  for (const file of ["solver/gpu.ts", "solver/run.ts", "solver/setup.ts", "bench.ts", "workers/case.worker.ts"])
    assert.ok(!files.includes(join(root, "src", file)), file);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(!pkg.scripts["build:webgpu"]);
});
