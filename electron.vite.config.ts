import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "codex-monitor-worker": resolve(__dirname, "electron/codex-monitor-worker.ts"),
        },
      },
    } as never,
  },
  // Sandboxed Electron preload scripts execute as CommonJS. Keeping this
  // explicit avoids electron-vite following package.json's ESM mode and
  // emitting an index.mjs file that Chromium cannot execute in the sandbox.
  preload: {
    build: {
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.js" } },
    } as never,
  },
  renderer: {
    root: ".",
    plugins: [react()],
    server: { port: 1420, strictPort: true },
    build: { rollupOptions: { input: resolve(__dirname, "index.html") } } as never,
  },
});
