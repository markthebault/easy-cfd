import { defineConfig } from "@playwright/test";

const port = Number(process.env.EASYCFD_WEB_TEST_PORT ?? "5173");

// Real OpenFOAM WASM runs and WebGL rendering in headless Chromium.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    browserName: "chromium",
    launchOptions: { args: process.platform === "darwin" ? [ "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { VITE_ENABLE_OPENFOAM: process.env.VITE_ENABLE_OPENFOAM ?? "true" },
    timeout: 60_000,
  },
});
