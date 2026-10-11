import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Static build: bundle every asset; optional OpenFOAM requests use the selected backend.
export default defineConfig({
  plugins: [react()],
  base: "./",
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: resolve(__dirname, "index.html") } },
  },
});
