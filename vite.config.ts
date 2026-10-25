import { defineConfig } from "vite";

export default defineConfig({
  // Use one origin in production. Vite proxies API calls while developing locally.
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { outDir: "dist", emptyOutDir: true },
});
