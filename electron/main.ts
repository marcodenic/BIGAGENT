import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, extname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { codexDesktopSessions, codexSourceSignature, codexSessionStoreAvailable } from "./codex-sessions";
import { uncoveredCodexEvents } from "./codex-feed";
import { ClaudeProvider } from "./providers/claude";
import { CodexAppServerProvider } from "./providers/codex-app-server";
import { createStructuredHookProviders, type StructuredHookProvider } from "./providers/structured-hooks";
import type { ProviderHealth, ProviderId } from "./providers/types";
import { TelemetryHub } from "./telemetry/hub";
import { startOpenCodeSource } from "./telemetry/opencode";
import { createTelemetryServer, listenTelemetryServer } from "./telemetry/server";

import { IdleDisplay } from "./idle-display";

app.setName("BIG AGENT");
const smokeTest = process.argv.includes("--smoke-test");
app.setPath("userData", smokeTest
  ? process.env.BIG_AGENT_SMOKE_USER_DATA || join(app.getPath("temp"), `big-agent-smoke-${process.pid}`)
  : join(app.getPath("appData"), "BIG AGENT"));

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
let idleDisplay: IdleDisplay | null = null;
let stopOpenCodeSource: (() => void) | null = null;
let codexProvider: CodexAppServerProvider | null = null;
let claudeProvider: ClaudeProvider | null = null;
let structuredProviders: StructuredHookProvider[] = [];
let previousSignature = "";
let previousSessions = "";
let safetyRefreshAt = 0;
const telemetryHub = new TelemetryHub();
const allowCodexFallback = process.env.BIG_AGENT_CODEX_FALLBACK !== "0";
let localCodexEvents: ReturnType<typeof codexDesktopSessions> = [];
const providerHealth = new Map<ProviderId, ProviderHealth>();
const providerOrder: ProviderId[] = ["codex", "claude", "grok", "cursor", "gemini", "copilot", "windsurf", "opencode"];

function providerSnapshot() {
  return [...providerHealth.values()].sort((left, right) => providerOrder.indexOf(left.id) - providerOrder.indexOf(right.id));
}

function send(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function updateProviderHealth(health: ProviderHealth) {
  providerHealth.set(health.id, health);
  send("big-agent:providers", providerSnapshot());
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

function refreshSessions(force = false) {
  if (!allowCodexFallback) return;
  const now = Date.now();
  try {
    const signature = codexSourceSignature();
    if (!force && signature === previousSignature && now < safetyRefreshAt) return;
    localCodexEvents = codexDesktopSessions();
    const latest = new Map(localCodexEvents.map((event) => [
      (event.meta as Record<string, unknown>).threadId, event,
    ]));
    codexProvider?.noteLocalFeed(codexSessionStoreAvailable(), [...latest.values()]
      .filter((event) => event.status !== "complete" && event.status !== "error").length);
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
    codexProvider?.noteLocalFeed(false, 0);
    telemetryHub.markSource("codex-desktop-fallback", "codex", "rollout-jsonl-fallback", "error", error instanceof Error ? error.message : String(error));
    console.error("Codex session refresh failed:", error);
  }
}

function startSessionWatcher() {
  if (!allowCodexFallback) return;
  refreshSessions(true);
  watcherTimer = setInterval(refreshSessions, 250);
  watcherTimer.unref();
}

function codexFallbackEvents() {
  if (!allowCodexFallback) return [];
  const live = Object.entries(telemetryHub.eventsBySource())
    .filter(([source]) => ["codex-hooks", "codex-app-server", "codex-json"].includes(source))
    .flatMap(([, events]) => events);
  return uncoveredCodexEvents(localCodexEvents, live).map((event) => ({
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
  protocolServer.on("listening", () => {
    claudeProvider?.setReceiverListening(true);
    structuredProviders.forEach((provider) => provider.setReceiverListening(true));
  });
  protocolServer.on("close", () => {
    claudeProvider?.setReceiverListening(false);
    structuredProviders.forEach((provider) => provider.setReceiverListening(false));
  });
  listenTelemetryServer(protocolServer);
}

async function installObservationBridge(source: string) {
  const destination = join(app.getPath("userData"), "bin", "big-agent.mjs");
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, temporary);
  await rename(temporary, destination);
  return destination;
}

function windowForEvent(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

function registerIpc() {
  ipcMain.handle("big-agent:get-sessions", () => allSessionEvents());
  ipcMain.handle("big-agent:get-snapshot", () => ({ events: allSessionEvents(), sources: telemetryHub.health(), providers: providerSnapshot(), legacy: null }));
  ipcMain.handle("big-agent:get-providers", () => providerSnapshot());
  ipcMain.handle("big-agent:provider-action", async (_event, provider: ProviderId, action: "setup" | "retry" | "launch" | "remove") => {
    if (!providerOrder.includes(provider)) throw new Error("Unknown provider");
    if (!(["setup", "retry", "launch", "remove"] as string[]).includes(action)) throw new Error("Unknown provider action");
    if (provider === "codex") {
      await codexProvider?.action(action);
      refreshSessions(true);
    }
    else if (provider === "claude") await claudeProvider?.action(action);
    else await structuredProviders.find((candidate) => candidate.health().id === provider)?.action(action);
    return providerSnapshot();
  });
  ipcMain.handle("big-agent:image-preview", (_event, path: string) => imagePreview(path));
  ipcMain.handle("big-agent:set-screen-awake", (_event, active: boolean) => idleDisplay?.setActive(Boolean(active)));
  ipcMain.handle("big-agent:toggle-fullscreen", (event) => {
    const window = windowForEvent(event);
    if (window) idleDisplay?.toggleFullscreen(window);
  });
  ipcMain.handle("big-agent:exit-fullscreen", (event) => { idleDisplay?.dismiss(); windowForEvent(event)?.setFullScreen(false); });
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
  mainWindow.on("closed", () => { idleDisplay?.setActive(false); mainWindow = null; });
  mainWindow.webContents.on("render-process-gone", () => idleDisplay?.setActive(false));
  mainWindow.webContents.on("did-finish-load", () => send("big-agent:providers", providerSnapshot()));
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
    if (process.platform === "win32") app.setAppUserModelId("com.bigagent.display");
    Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([
      { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]) : null);
    if (smokeTest) {
      registerIpc();
      await createWindow();
      const passed = await mainWindow!.webContents.executeJavaScript(`new Promise(resolve => {
        let attempts = 0;
        const check = async () => {
          if (document.querySelector('.app') && window.bigAgentDesktop?.platform === 'electron') {
            try { resolve(Array.isArray(await window.bigAgentDesktop.getSessions())); } catch { resolve(false); }
          } else if (++attempts >= 100) resolve(false);
          else setTimeout(check, 100);
        };
        check();
      })`);
      console.log(passed ? "BIG_AGENT_SMOKE_OK" : "BIG_AGENT_SMOKE_FAILED");
      app.exit(passed ? 0 : 1);
      return;
    }
    codexProvider = new CodexAppServerProvider(telemetryHub, updateProviderHealth);
    claudeProvider = new ClaudeProvider(telemetryHub, updateProviderHealth);
    const bundledBridge = app.isPackaged
      ? join(process.resourcesPath, "bin", "big-agent.mjs")
      : join(__dirname, "../bridge/big-agent.mjs");
    const bridgeScript = await installObservationBridge(bundledBridge);
    const observationExecutable = process.env.APPIMAGE || process.execPath;
    structuredProviders = createStructuredHookProviders(observationExecutable, bridgeScript, updateProviderHealth);
    idleDisplay = new IdleDisplay(() => mainWindow);
    registerIpc();
    telemetryHub.onEvent((event) => {
      send("big-agent:event", event);
      if (event.meta?.product === "claude" && event.meta?.source === "claude-hooks") claudeProvider?.noteHookEvent();
      const structured = structuredProviders.find((provider) => provider.health().id === event.meta?.product);
      structured?.noteEvent();
      if (event.meta?.product === "codex" && event.meta?.source !== "codex-desktop-fallback") {
        // Hand matching turns to the live source without hiding other desktop
        // tasks that are running on a separate server.
        refreshSessions(true);
      }
    });
    telemetryHub.onHealth((sources) => send("big-agent:sources", sources));
    startProtocolServer();
    await createWindow();
    startSessionWatcher();
    void codexProvider.start();
    void claudeProvider.start();
    structuredProviders.forEach((provider) => void provider.start());
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
  codexProvider?.stop();
  claudeProvider?.stop();
  structuredProviders.forEach((provider) => provider.stop());
  protocolServer?.close();
  idleDisplay?.stop();
});
