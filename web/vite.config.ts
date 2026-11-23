import { defineConfig } from "vite";

// `pnpm dev` serves the app with hot reload and sends /api to a running Scope Soup (or `pnpm demo`).
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4310", changeOrigin: false } } },
});
