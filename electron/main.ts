import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { extname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker } from "electron";
import { codexDesktopSessions, codexDesktopSnapshot, codexSourceSignature } from "./codex-sessions";
import { TelemetryHub } from "./telemetry/hub";
import { startOpenCodeSource } from "./telemetry/opencode";
import { createTelemetryServer, listenTelemetryServer } from "./telemetry/server";

app.setName("BIG AGENT");
app.setPath("userData", join(app.getPath("appData"), "BIG AGENT"));

// Native Vulkan selection is consumed before Electron runs application code,
// so it must be present on the executable's original command line. Relaunch
// once, before creating a window, on the NVIDIA/X11 combination that otherwise
// crashes ANGLE's OpenGL process and falls back to software compositing.
const gpuRelaunchMarker = "--big-agent-gpu-configured";
const needsNvidiaX11Relaunch = process.platform === "linux"
  && process.env.GDK_BACKEND === "x11"
  && existsSync("/proc/driver/nvidia/version")
  && process.env.BIG_AGENT_GPU_CONFIGURED !== "1"
  && !process.argv.includes(gpuRelaunchMarker);
if (needsNvidiaX11Relaunch) {
  app.relaunch({
    args: [
      "--ozone-platform=x11",
      "--enable-features=Vulkan",
      "--use-vulkan=native",
      "--use-gl=angle",
      "--use-angle=vulkan",
      ...process.argv.slice(1),
      gpuRelaunchMarker,
    ],
  });
  app.exit(0);
}

const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".avif", "image/avif"],
]);

let mainWindow: BrowserWindow | null = null;
let protocolServer: Server | null = null;
let watcherTimer: NodeJS.Timeout | null = null;
let wakeLockId: number | null = null;
let stopOpenCodeSource: (() => void) | null = null;
let previousSignature = "";
let previousSessions = "";
let safetyRefreshAt = 0;
const telemetryHub = new TelemetryHub();

function send(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function setScreenAwake(active: boolean) {
  if (active && wakeLockId === null) wakeLockId = powerSaveBlocker.start("prevent-display-sleep");
  if (!active && wakeLockId !== null) {
    if (powerSaveBlocker.isStarted(wakeLockId)) powerSaveBlocker.stop(wakeLockId);
    wakeLockId = null;
  }
}

async function imagePreview(path: string) {
  if (!isAbsolute(path)) throw new Error("image path must be absolute");
  const mime = IMAGE_MIME.get(extname(path).toLowerCase());
  if (!mime) throw new Error("unsupported image format");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new Error("image is unavailable or too large");
  const bytes = await readFile(path);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function emitProcessEvent(payload: unknown) {
  telemetryHub.ingest({ source: "process", product: "generic", transport: "child-process", format: "protocol", payload });
}

function runProcess(command: string, args: string[]) {
  if (!command.trim()) throw new Error("command is required");
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  emitProcessEvent({
    version: 1,
    id: `process-start-${child.pid || Date.now()}`,
    timestamp: "",
    kind: "command.start",
    status: "command",
    command: [command, ...args].join(" "),
  });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      emitProcessEvent({ version: 1, id: `stdout-${Date.now()}-${line.length}`, timestamp: "", kind: "activity", status: "working", detail: line });
    }
  });
  child.on("error", (error) => emitProcessEvent({ version: 1, id: "process-launch-error", timestamp: "", kind: "error", status: "error", detail: error.message }));
  child.on("exit", (code) => emitProcessEvent(code === 0
    ? { version: 1, id: "process-complete", timestamp: "", kind: "complete", status: "complete", detail: "Process completed" }
    : { version: 1, id: "process-error", timestamp: "", kind: "error", status: "error", detail: `Process exited with code ${code ?? -1}`, exitCode: code }));
}

function refreshSessions(force = false) {
  const signature = codexSourceSignature();
  const now = Date.now();
  if (!force && signature === previousSignature && now < safetyRefreshAt) return;
  try {
    const sessions = codexFallbackEvents();
    telemetryHub.markSource("codex-desktop-fallback", "codex", "rollout-jsonl-fallback", sessions.length ? "live" : "idle", undefined, sessions.length);
    const serialized = JSON.stringify(sessions);
    if (serialized !== previousSessions) {
      send("big-agent:sessions", sessions);
      previousSessions = serialized;
    }
    previousSignature = signature;
    safetyRefreshAt = now + 15_000;
  } catch (error) {
    telemetryHub.markSource("codex-desktop-fallback", "codex", "rollout-jsonl-fallback", "error", error instanceof Error ? error.message : String(error));
    console.error("Codex session refresh failed:", error);
  }
}

function startSessionWatcher() {
  refreshSessions(true);
  watcherTimer = setInterval(refreshSessions, 250);
  watcherTimer.unref();
}

function codexFallbackEvents() {
  return codexDesktopSessions().map((event) => ({
    ...event,
    meta: { ...(event.meta && typeof event.meta === "object" ? event.meta : {}), source: "codex-desktop-fallback", product: "codex", transport: "rollout-jsonl-fallback" },
  }));
}

function allSessionEvents() {
  return [...codexFallbackEvents(), ...Object.values(telemetryHub.eventsBySource()).flat()];
}

function startProtocolServer() {
  protocolServer = createTelemetryServer(telemetryHub);
  protocolServer.on("error", (error) => console.error("Protocol server unavailable:", error.message));
  listenTelemetryServer(protocolServer);
}

function windowForEvent(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

function registerIpc() {
  ipcMain.handle("big-agent:get-sessions", () => allSessionEvents());
  ipcMain.handle("big-agent:get-snapshot", () => ({ events: allSessionEvents(), sources: telemetryHub.health(), legacy: codexDesktopSnapshot() }));
  ipcMain.handle("big-agent:image-preview", (_event, path: string) => imagePreview(path));
  ipcMain.handle("big-agent:run-process", (_event, command: string, args: string[]) => runProcess(command, args));
  ipcMain.handle("big-agent:set-screen-awake", (_event, active: boolean) => setScreenAwake(Boolean(active)));
  ipcMain.handle("big-agent:toggle-fullscreen", (event) => {
    const window = windowForEvent(event);
    if (window) window.setFullScreen(!window.isFullScreen());
  });
  ipcMain.handle("big-agent:exit-fullscreen", (event) => windowForEvent(event)?.setFullScreen(false));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "BIG AGENT",
    width: 1280,
    height: 800,
    minWidth: 420,
    minHeight: 320,
    backgroundColor: "#070806",
    icon: process.platform === "linux"
      ? app.isPackaged ? join(process.resourcesPath, "icon.png") : join(__dirname, "../../electron/assets/128x128.png")
      : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.on("maximize", () => mainWindow?.setAlwaysOnTop(true));
  mainWindow.on("unmaximize", () => mainWindow?.setAlwaysOnTop(false));
  mainWindow.on("closed", () => { mainWindow = null; });
  // Map the native surface before Chromium initializes its Vulkan compositor.
  // A hidden X11 window has no usable geometry for Vulkan surface creation.
  mainWindow.maximize();
  mainWindow.setAlwaysOnTop(true);

  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerIpc();
    telemetryHub.onEvent((event) => send("big-agent:event", event));
    telemetryHub.onHealth((sources) => send("big-agent:sources", sources));
    startProtocolServer();
    await createWindow();
    startSessionWatcher();
    stopOpenCodeSource = startOpenCodeSource(telemetryHub);
    setTimeout(() => console.info("Electron GPU feature status:", app.getGPUFeatureStatus()), 3_000).unref();
  }).catch((error) => {
    console.error("BIG AGENT startup failed:", error);
    app.quit();
  });
}

app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (watcherTimer) clearInterval(watcherTimer);
  stopOpenCodeSource?.();
  protocolServer?.close();
  setScreenAwake(false);
});
