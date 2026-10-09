import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Static build: every asset is bundled, nothing is fetched from a server at runtime.
export default defineConfig({
  plugins: [react()],
  base: "./",
  worker: { format: "es" },
  server: { proxy: { "/api": process.env.EASYCFD_API_URL ?? "http://127.0.0.1:8000" } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: resolve(__dirname, "index.html") } },
  },
});
