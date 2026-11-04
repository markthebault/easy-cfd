import { defineConfig } from "@playwright/test";

const port = Number(process.env.EASYCFD_FLOW_TEST_PORT ?? "5203");

// Test shipped, minified assets: development mode hid the WebKit startup bug.
export default defineConfig({
  testDir: "tests/production",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, colorScheme: "dark", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", launchOptions: { args: process.platform === "darwin" ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : [] } } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { VITE_ENABLE_OPENFOAM: "false" },
  },
});
