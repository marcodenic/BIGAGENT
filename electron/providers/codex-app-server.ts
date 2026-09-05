import spawn from "cross-spawn";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import type { TelemetryHub } from "../telemetry/hub";
import { removeBigAgentCodexHooks } from "../codex-authority";
import { findExecutable } from "./executables";
import type { ProviderHealth, ProviderHealthListener } from "./types";
import WebSocket from "ws";

type Json = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const SOURCE_ID = "codex-app-server";
const DESKTOP_MARKER = "X-BIGAGENT-Shared-App-Server=true";

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusType(thread: Json) {
  return string(object(thread.status).type) ?? string(thread.status) ?? "notLoaded";
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function run(binary: string, args: string[], timeoutMs = 8_000, env?: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${args.join(" ")} exited with code ${code ?? -1}`));
    });
  });
}

async function installStandaloneCodex() {
  if (process.platform === "win32") throw new Error("Install the standalone Codex CLI for Windows, then choose RECHECK");
  const response = await fetch("https://chatgpt.com/codex/install.sh", { redirect: "follow" });
  if (!response.ok) throw new Error(`Codex installer returned ${response.status}`);
  const script = await response.text();
  if (!script.startsWith("#!/bin/sh") || !script.includes("https://releases.openai.com/codex") || script.length < 10_000) {
    throw new Error("The official Codex installer response was not recognized");
  }
  const directory = await mkdtemp(join(tmpdir(), "bigagent-codex-install-"));
  const path = join(directory, "install.sh");
  try {
    await writeFile(path, script, { mode: 0o700 });
    await run("/bin/sh", [path], 5 * 60_000, { ...process.env, CODEX_NON_INTERACTIVE: "1" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function sharedCodexDesktopEntry(contents: string) {
  if (contents.includes(DESKTOP_MARKER) && /CODEX_APP_SERVER_USE_LOCAL_DAEMON=1/.test(contents)) return contents;
  const lines = contents.trimEnd().split("\n");
  const execIndex = lines.findIndex((line) => line.startsWith("Exec="));
  if (execIndex >= 0 && !lines[execIndex].includes("CODEX_APP_SERVER_USE_LOCAL_DAEMON=1")) {
    lines[execIndex] = `Exec=/usr/bin/env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 ${lines[execIndex].slice("Exec=".length)}`;
  }
  if (!lines.includes(DESKTOP_MARKER)) lines.push(DESKTOP_MARKER);
  return `${lines.join("\n")}\n`;
}

export function unsharedCodexDesktopEntry(contents: string) {
  const lines = contents.trimEnd().split("\n")
    .filter((line) => line !== DESKTOP_MARKER)
    .map((line) => line.startsWith("Exec=/usr/bin/env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 ")
      ? `Exec=${line.slice("Exec=/usr/bin/env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 ".length)}`
      : line);
  return `${lines.join("\n")}\n`;
}

async function writeAtomic(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.bigagent-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
}

export function unixSocketPeerInodes(socketList: string, socketPath: string) {
  const peers = new Set<string>();
  for (const line of socketList.split("\n")) {
    const pathIndex = line.indexOf(socketPath);
    if (pathIndex < 0) continue;
    const fields = line.slice(pathIndex + socketPath.length).trim().split(/\s+/);
    if (/^\d+$/.test(fields[0] ?? "") && fields[1] === "*" && /^\d+$/.test(fields[2] ?? "")) peers.add(fields[2]);
  }
  return peers;
}

async function sharedDaemonPeerInodes() {
  const socketPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
  const result = await run("ss", ["-xnpH"], 2_000).catch(() => undefined);
  return unixSocketPeerInodes(result?.stdout ?? "", socketPath);
}

async function processSocketInodes(pid: string) {
  const descriptors = await readdir(`/proc/${pid}/fd`).catch(() => []);
  const inodes = new Set<string>();
  await Promise.all(descriptors.map(async (descriptor) => {
    const target = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => "");
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }));
  return inodes;
}

async function linuxDesktopProcesses() {
  if (process.platform !== "linux") return [] as Array<{ pid: number; shared: boolean }>;
  const daemonPeers = await sharedDaemonPeerInodes();
  const entries = await readdir("/proc", { withFileTypes: true }).catch(() => []);
  const found: Array<{ pid: number; shared: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const command = (await readFile(`/proc/${entry.name}/cmdline`)).toString().split("\0").filter(Boolean);
      if (!command.length || !/(?:ChatGPT|chatgpt)$/.test(command[0]) || command.some((part) => part.startsWith("--type="))) continue;
      const environment = (await readFile(`/proc/${entry.name}/environ`)).toString();
      const inheritedMarker = environment.split("\0").includes("CODEX_APP_SERVER_USE_LOCAL_DAEMON=1");
      const sockets = inheritedMarker ? new Set<string>() : await processSocketInodes(entry.name);
      const attachedToDaemon = [...sockets].some((inode) => daemonPeers.has(inode));
      found.push({ pid: Number(entry.name), shared: inheritedMarker || attachedToDaemon });
    } catch {
      // Processes can exit while /proc is being read.
    }
  }
  return found;
}

export class CodexAppServerProvider {
  private binary?: string;
  private socket?: WebSocket;
  private stopped = false;
  private starting = false;
  private connected = false;
  private configured = false;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threads = new Map<string, Json>();
  private readonly subscribed = new Set<string>();
  private readonly subscribing = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private desktopRunning = false;
  private desktopShared = false;
  private standaloneMissing = false;
  private lastEventAt?: string;
  private lastError?: string;
  private localFeedReady = false;
  private localActiveSessions = 0;

  constructor(private readonly hub: TelemetryHub, private readonly onHealth: ProviderHealthListener) {}

  noteLocalFeed(ready: boolean, activeSessions: number) {
    this.localFeedReady = ready;
    this.localActiveSessions = activeSessions;
    this.publishHealth();
  }

  health(): ProviderHealth {
    const canLaunch = process.platform === "linux";
    if (this.localFeedReady) {
      return {
        id: "codex", label: "CODEX", transport: "LOCAL SESSION FILES",
        state: "ready", configured: true, connected: true, listening: true,
        activeSessions: this.localActiveSessions,
        detail: `Monitoring Codex session files · ${this.localActiveSessions} active task${this.localActiveSessions === 1 ? "" : "s"}`,
        actions: [{ id: "retry", label: "RECHECK" },
          ...(canLaunch ? [{ id: "launch" as const, label: "OPEN CODEX" }] : [])],
      };
    }
    const state = !this.binary
      ? "unavailable"
      : this.standaloneMissing
        ? "needs-setup"
      : !this.configured && canLaunch
        ? "needs-setup"
      : this.lastError && !this.connected
        ? "error"
        : !this.connected
          ? "connecting"
          : this.desktopRunning && !this.desktopShared
            ? "error"
            : "ready";
    const detail = !this.binary
      ? "Codex CLI was not found"
      : this.standaloneMissing
        ? process.platform === "win32" ? "Install the standalone Codex CLI for Windows, then choose RECHECK" : "The official standalone Codex CLI is required for the shared daemon"
      : !this.configured && canLaunch
        ? "App Server available · set up Codex Desktop to join the shared feed"
      : this.lastError && !this.connected
        ? this.lastError
        : this.connected && this.desktopRunning && !this.desktopShared
          ? "Codex is using a separate server; local session monitoring is unavailable"
          : this.connected && this.desktopRunning
            ? `Shared feed connected · ${this.subscribed.size} loaded thread${this.subscribed.size === 1 ? "" : "s"}`
            : this.connected
              ? "Shared feed connected · Codex is not open"
              : "Connecting to the shared App Server";
    const actions: ProviderHealth["actions"] = [];
    if (this.standaloneMissing && process.platform !== "win32") actions.push({ id: "setup", label: "INSTALL CODEX CLI" });
    else if (this.standaloneMissing) actions.push({ id: "retry", label: "RECHECK" });
    else if (!this.configured && canLaunch) actions.push({ id: "setup", label: "SET UP CODEX" });
    if (this.binary && !this.connected && !this.standaloneMissing) actions.push({ id: "retry", label: "RETRY" });
    if (canLaunch) actions.push({ id: "launch", label: "OPEN CODEX" });
    if (this.configured && canLaunch) actions.push({ id: "remove", label: "REMOVE INTEGRATION" });
    return {
      id: "codex",
      label: "CODEX",
      transport: "APP SERVER",
      state,
      configured: this.configured,
      connected: this.connected,
      listening: this.connected,
      activeSessions: [...this.threads.values()].filter((thread) => statusType(thread) === "active").length,
      detail,
      lastEventAt: this.lastEventAt,
      actions,
    };
  }

  async start() {
    if (this.starting || this.connected) return;
    this.starting = true;
    this.stopped = false;
    this.lastError = undefined;
    this.binary = await findExecutable("codex", [
      process.env.CODEX_CLI_PATH,
      join(process.env.CODEX_HOME || join(homedir(), ".codex"), "packages", "standalone", "current", "bin", "codex"),
      join(process.env.CODEX_HOME || join(homedir(), ".codex"), "packages", "standalone", "current", "codex"),
      process.platform === "linux" ? "/usr/lib/chatgpt/resources/codex" : undefined,
      process.platform === "darwin" ? "/Applications/Codex.app/Contents/Resources/codex" : undefined,
    ]);
    this.configured = await this.desktopLauncherConfigured().catch(() => false);
    this.publishHealth();
    if (!this.binary) {
      this.starting = false;
      this.publishHealth();
      return;
    }
    try {
      await run(this.binary, ["app-server", "daemon", "start"]);
      await this.connect();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.standaloneMissing = /managed standalone Codex install not found|requires the standalone install/i.test(this.lastError);
      this.hub.markSource(SOURCE_ID, "codex", "app-server-json-rpc", "error", this.lastError);
      this.scheduleReconnect();
    } finally {
      this.starting = false;
      this.publishHealth();
    }
  }

  async action(action: "setup" | "retry" | "launch" | "remove") {
    if (action === "setup") {
      if (this.standaloneMissing) {
        await installStandaloneCodex();
        this.standaloneMissing = false;
        this.disconnect();
        await this.start();
        return;
      }
      this.configured = await this.configureDesktopLauncher();
      this.publishHealth();
      return;
    }
    if (action === "retry") {
      this.disconnect();
      await this.start();
      return;
    }
    if (action === "remove") {
      await this.removeDesktopLauncher();
      this.configured = false;
      this.publishHealth();
      return;
    }
    await this.launchDesktop();
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.disconnect();
  }

  private async configureDesktopLauncher() {
    if (process.platform !== "linux") return true;
    const localPath = join(homedir(), ".local", "share", "applications", "chatgpt.desktop");
    let contents = await readFile(localPath, "utf8").catch(() => "");
    if (!contents) contents = await readFile("/usr/share/applications/chatgpt.desktop", "utf8").catch(() => "");
    if (!contents) return false;
    const configured = sharedCodexDesktopEntry(contents);
    if (configured !== contents) await writeAtomic(localPath, configured);
    return configured.includes(DESKTOP_MARKER) && configured.includes("CODEX_APP_SERVER_USE_LOCAL_DAEMON=1");
  }

  private async desktopLauncherConfigured() {
    if (process.platform !== "linux") return true;
    const localPath = join(homedir(), ".local", "share", "applications", "chatgpt.desktop");
    const contents = await readFile(localPath, "utf8").catch(() => "");
    return contents.includes(DESKTOP_MARKER) && contents.includes("CODEX_APP_SERVER_USE_LOCAL_DAEMON=1");
  }

  private async removeDesktopLauncher() {
    if (process.platform !== "linux") return;
    const localPath = join(homedir(), ".local", "share", "applications", "chatgpt.desktop");
    const contents = await readFile(localPath, "utf8").catch(() => "");
    if (!contents) return;
    const restored = unsharedCodexDesktopEntry(contents);
    if (restored !== contents) await writeAtomic(localPath, restored);
  }

  private async launchDesktop() {
    const launcher = await findExecutable("chatgpt", [process.platform === "linux" ? "/usr/bin/chatgpt" : undefined]);
    if (!launcher) throw new Error("Codex desktop launcher was not found");
    const child = spawn(launcher, [], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    await delay(500);
    await this.refreshDesktopState();
  }

  private async connect() {
    if (!this.binary || this.stopped) return;
    this.hub.markSource(SOURCE_ID, "codex", "app-server-json-rpc", "connecting");
    const socketPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
    // Codex's Unix listener intentionally does not negotiate WebSocket
    // extensions. `ws` offers permessage-deflate by default, which the daemon
    // rejects during the upgrade, so match the Desktop client's plain framing.
    const socket = new WebSocket(`ws+unix://${socketPath}:/rpc`, { perMessageDeflate: false });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("App Server socket connection timed out")), 5_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on("message", (data) => this.receiveLine(data.toString()));
    socket.on("error", (error) => this.handleDisconnect(error.message));
    socket.on("close", (_code, reason) => this.handleDisconnect(reason.toString() || "App Server socket closed"));
    await this.request("initialize", {
      clientInfo: { name: "big-agent", title: "BIG AGENT", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    this.connected = true;
    this.lastError = undefined;
    // Earlier BIG AGENT builds installed command hooks as an interim Codex
    // transport. Once the official App Server connection is proven, remove
    // only those owned actions so the two feeds cannot duplicate each other.
    await this.removeLegacyHookBridge().catch(() => undefined);
    this.hub.markSource(SOURCE_ID, "codex", "app-server-json-rpc", "live");
    await this.reconcileLoadedThreads();
    this.pollTimer = setInterval(() => void this.reconcileLoadedThreads().catch((error) => this.handlePollError(error)), 2_500);
    this.pollTimer.unref();
  }

  private request(method: string, params: Json) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("App Server socket is not connected"));
    const id = ++this.requestId;
    const message = JSON.stringify({ method, id, params });
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 8_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(message);
    });
  }

  private notify(method: string, params?: Json) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(params ? { method, params } : { method }));
  }

  private receiveLine(line: string) {
    let message: Json;
    try { message = object(JSON.parse(line)); } catch { return; }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && !message.method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = object(message.error);
      if (Object.keys(error).length) pending.reject(new Error(string(error.message) || "App Server request failed"));
      else pending.resolve(object(message.result));
      return;
    }
    const method = string(message.method);
    if (!method) return;
    // Server-initiated requests (approvals, dynamic tools, user input) are
    // deliberately observed but never answered by this read-only client.
    this.observe(message);
  }

  private observe(message: Json) {
    const method = string(message.method) ?? "";
    const params = object(message.params);
    const notifiedThread = object(params.thread);
    const threadId = string(params.threadId) ?? string(notifiedThread.id);
    if (method === "thread/started" && threadId) {
      this.threads.set(threadId, notifiedThread);
      if (!this.subscribed.has(threadId) && !this.subscribing.has(threadId)) void this.subscribeThread(threadId);
    } else if (method === "thread/status/changed" && threadId) {
      const previous = this.threads.get(threadId) ?? { id: threadId };
      this.threads.set(threadId, { ...previous, status: params.status });
    } else if (/^thread\/(?:closed|deleted|archived)$/.test(method) && threadId) {
      this.threads.delete(threadId);
      this.subscribed.delete(threadId);
    }
    const metadata = threadId ? this.threads.get(threadId) : undefined;
    const enriched = metadata
      ? { ...message, params: { ...params, thread: Object.keys(notifiedThread).length ? notifiedThread : metadata } }
      : message;
    this.lastEventAt = new Date().toISOString();
    this.hub.ingest({ source: SOURCE_ID, product: "codex", transport: "app-server-json-rpc", format: "codex-app-server", payload: enriched });
    this.publishHealth();
  }

  private async reconcileLoadedThreads() {
    if (!this.connected && this.subscribed.size) return;
    const result = await this.request("thread/loaded/list", {});
    const loaded = new Set((Array.isArray(result.data) ? result.data : []).filter((value): value is string => typeof value === "string"));
    await Promise.all([...loaded].filter((id) => !this.subscribed.has(id) && !this.subscribing.has(id)).map((id) => this.subscribeThread(id)));
    for (const id of [...this.subscribed]) {
      if (loaded.has(id)) continue;
      this.observe({ method: "thread/status/changed", emittedAtMs: Date.now(), params: { threadId: id, status: { type: "notLoaded" } } });
      this.subscribed.delete(id);
      this.threads.delete(id);
    }
    await this.refreshDesktopState();
    this.publishHealth();
  }

  private async subscribeThread(threadId: string) {
    this.subscribing.add(threadId);
    try {
      const result = await this.request("thread/resume", { threadId });
      const thread = object(result.thread);
      if (!Object.keys(thread).length) return;
      const enrichedThread: Json = {
        ...thread,
        model: result.model,
        modelProvider: result.modelProvider ?? thread.modelProvider,
        reasoningEffort: result.reasoningEffort,
      };
      this.threads.set(threadId, enrichedThread);
      this.subscribed.add(threadId);
      this.observe({ method: "thread/started", emittedAtMs: Date.now(), params: { thread: enrichedThread } });
      this.observe({ method: "thread/status/changed", emittedAtMs: Date.now(), params: { threadId, status: enrichedThread.status } });
      if (statusType(enrichedThread) === "active") this.replayActiveTurn(enrichedThread);
    } finally {
      this.subscribing.delete(threadId);
    }
  }

  private replayActiveTurn(thread: Json) {
    const turns = Array.isArray(thread.turns) ? thread.turns.map(object) : [];
    const activeTurn = [...turns].reverse().find((turn) => /progress|running|active/i.test(string(turn.status) ?? string(object(turn.status).type) ?? ""));
    const threadId = string(thread.id);
    const turnId = string(activeTurn?.id);
    if (!activeTurn || !threadId || !turnId) return;
    this.observe({ method: "turn/started", emittedAtMs: Date.now(), params: { threadId, turn: activeTurn } });
    for (const itemValue of Array.isArray(activeTurn.items) ? activeTurn.items : []) {
      const item = object(itemValue);
      const itemStatus = string(item.status) ?? string(object(item.status).type) ?? "";
      const method = /progress|running|pending|active/i.test(itemStatus) ? "item/started" : "item/completed";
      this.observe({ method, emittedAtMs: Date.now(), params: { threadId, turnId, item } });
    }
  }

  private async refreshDesktopState() {
    const processes = await linuxDesktopProcesses();
    this.desktopRunning = processes.length > 0;
    this.desktopShared = processes.some((entry) => entry.shared);
  }

  private async removeLegacyHookBridge() {
    const hooksPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json");
    const contents = await readFile(hooksPath, "utf8").catch(() => undefined);
    if (!contents) return;
    const migrated = removeBigAgentCodexHooks(JSON.parse(contents));
    if (!migrated.removed) return;
    await writeAtomic(hooksPath, `${JSON.stringify(migrated.value, null, 2)}\n`);
  }

  private handlePollError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not connected|broken pipe|closed/i.test(message)) this.handleDisconnect(message);
    else {
      this.lastError = message;
      this.publishHealth();
    }
  }

  private handleDisconnect(error: string) {
    if (!this.connected && !this.socket) return;
    this.lastError = error;
    this.connected = false;
    this.disconnect();
    this.hub.markSource(SOURCE_ID, "codex", "app-server-json-rpc", "error", error);
    this.publishHealth();
    this.scheduleReconnect();
  }

  private disconnect() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.terminate();
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("App Server connection closed"));
    }
    this.pending.clear();
    this.connected = false;
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start();
    }, 2_000);
    this.reconnectTimer.unref();
  }

  private publishHealth() {
    this.onHealth(this.health());
  }
}
