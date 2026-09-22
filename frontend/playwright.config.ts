import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: {
    actionTimeout: 15000,
    navigationTimeout: 20000,
    baseURL: "http://127.0.0.1:8000",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  timeout: 60000,
  workers: 1,
});
