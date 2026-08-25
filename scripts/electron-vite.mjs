#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2];
const executable = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "electron-vite.cmd" : "electron-vite");
const args = command ? [command] : [];
const environment = { ...process.env };

if (!command && process.platform === "linux" && process.env.GDK_BACKEND === "x11" && existsSync("/proc/driver/nvidia/version")) {
  environment.BIG_AGENT_GPU_CONFIGURED = "1";
  environment.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  environment.ELECTRON_CLI_ARGS = JSON.stringify([
    "--ozone-platform=x11",
    "--enable-features=Vulkan",
    "--use-vulkan=native",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--big-agent-gpu-configured",
  ]);
}

const child = spawn(executable, args, { stdio: "inherit", env: environment });
child.on("error", (error) => {
  console.error(`Unable to start Electron: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
