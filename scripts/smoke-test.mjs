import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const candidates = process.platform === "darwin"
  ? [`release/mac${process.arch === "arm64" ? "-arm64" : ""}/BIG AGENT.app/Contents/MacOS/BIG AGENT`]
  : process.platform === "win32" ? ["release/win-unpacked/BIG AGENT.exe"] : ["release/linux-unpacked/big-agent"];
const executable = process.argv[2] ? resolve(process.argv[2]) : candidates.map(resolvePath => resolve(resolvePath)).find(existsSync);
if (!executable || !existsSync(executable)) throw new Error("Packaged executable not found; run pnpm package:dir first");
const temporary = await mkdtemp(join(tmpdir(), "big-agent-smoke-"));
try {
  const resources = process.platform === "darwin" ? join(dirname(executable), "..", "Resources") : join(dirname(executable), "resources");
  const bridge = join(temporary, "big-agent.mjs");
  await copyFile(join(resources, "bin", "big-agent.mjs"), bridge);
  await new Promise((resolveTest, reject) => {
    const child = spawn(executable, [bridge, "hook", "gemini"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BIG_AGENT_URL: "http://127.0.0.1:1/event" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.resume();
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Installed hook bridge timed out")); }, 10000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0 && output.trim() === "{}") resolveTest();
      else reject(new Error(`Installed hook bridge failed (${code}): ${output}`));
    });
    child.stdin.end("{}");
  });
  await new Promise((resolveTest, reject) => {
    const env = { ...process.env, BIG_AGENT_SMOKE_USER_DATA: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, ["--smoke-test", "--disable-gpu", ...(process.platform === "linux" ? ["--ozone-platform=x11", "--big-agent-gpu-configured"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Packaged startup timed out\n${output}`)); }, 30000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0 && output.includes("BIG_AGENT_SMOKE_OK")) resolveTest();
      else reject(new Error(`Packaged startup failed (${code})\n${output}`));
    });
  });
  console.log(`Packaged renderer, preload IPC, and standalone hook bridge passed on ${process.platform}/${process.arch}`);
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
