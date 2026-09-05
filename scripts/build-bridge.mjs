import { build } from "esbuild";

// Installed hooks live outside app.asar. Bundle their dependencies so the
// receiver works without a separate Node/npm installation or node_modules.
await build({
  entryPoints: ["scripts/big-agent.mjs"],
  outfile: "out/bridge/big-agent.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: 'import { createRequire as createBridgeRequire } from "node:module"; const require = createBridgeRequire(import.meta.url);' },
});
