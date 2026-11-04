import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Static build: bundle every asset; optional OpenFOAM requests use the selected backend.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["@jax-js/jax"] },
  base: "./",
  worker: {
    format: "es",
    rollupOptions: { output: {
      // Keep jax-js and its lazy GPU backends together. Otherwise the GPU chunk
      // imports the worker entry, which WebKit evaluates again, splitting class
      // identities and failing private-method brand checks on cold startup.
      manualChunks(id) {
        if (id.includes("/node_modules/@jax-js/jax/")) return "jax-js-runtime";
      },
    } },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: resolve(__dirname, "index.html") } },
  },
});
