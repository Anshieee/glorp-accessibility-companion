import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" lets the static build be served from any sub-path by the same
// Cloud Run / host service that serves the API (easiest integration).
const devTarget = process.env.VITE_DEV_PROXY ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    // Proxy backend routes to the local server during development (default
    // port 8080, override with VITE_DEV_PROXY).
    proxy: {
      "/api": { target: devTarget, changeOrigin: true },
      "/fixtures": { target: devTarget, changeOrigin: true },
      "/mcp": { target: devTarget, changeOrigin: true },
      "/healthz": { target: devTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
