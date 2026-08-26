import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { findExecutable } from "./executables";
import type { ProviderHealth, ProviderHealthListener, ProviderId } from "./types";

type Json = Record<string, unknown>;

type HookProviderSpec = {
  id: Exclude<ProviderId, "codex" | "claude">;
  label: string;
  transport: string;
  executableNames: string[];
  executableCandidates: Array<string | undefined>;
  setupLabel: string;
  launchLabel: string;
  restartAfterSetup: boolean;
  inspect(command: string): Promise<boolean>;
  install(command: string): Promise<boolean>;
  uninstall(command: string): Promise<void>;
};

const CURSOR_EVENTS = [
  "sessionStart", "sessionEnd", "beforeSubmitPrompt", "preToolUse", "postToolUse",
  "postToolUseFailure", "subagentStart", "subagentStop", "preCompact", "stop",
  "afterAgentResponse", "afterAgentThought",
] as const;

const GEMINI_EVENTS = [
  "SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool",
  "Notification", "PreCompress",
] as const;

const COPILOT_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "PreCompact",
  "PermissionRequest", "Notification", "ErrorOccurred",
] as const;

const GROK_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure", "StopCancelled",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
] as const;

const WINDSURF_EVENTS = [
  "pre_read_code", "post_read_code", "pre_write_code", "post_write_code",
  "pre_run_command", "post_run_command", "pre_mcp_tool_use", "post_mcp_tool_use",
  "pre_user_prompt", "post_cascade_response",
] as const;

const HOOK_URL = "http://127.0.0.1:19777/hooks";

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function commandMarker(value: unknown, provider: string, expected?: string) {
  const command = typeof value === "string" ? value : "";
  if (expected) return command === expected;
  return /big-agent\.mjs/i.test(command) && new RegExp(`\\bhook\\s+${provider}\\b`, "i").test(command);
}

function containsCursorCommand(value: unknown, provider = "cursor", expected?: string) {
  return commandMarker(object(value).command, provider, expected);
}

function containsNestedCommand(value: unknown, provider: string, expected?: string) {
  return (Array.isArray(object(value).hooks) ? object(value).hooks as unknown[] : [])
    .some((entry) => commandMarker(object(entry).command, provider, expected));
}

function containsCopilotCommand(value: unknown, expected?: string) {
  const entry = object(value);
  return commandMarker(entry.command, "copilot", expected)
    || commandMarker(entry.bash, "copilot", expected)
    || commandMarker(entry.powershell, "copilot", expected);
}

function containsGrokHttp(value: unknown) {
  return (Array.isArray(object(value).hooks) ? object(value).hooks as unknown[] : [])
    .some((entry) => object(entry).type === "http" && object(entry).url === `${HOOK_URL}/grok`);
}

function mergeEventArrays(settings: unknown, events: readonly string[], entry: (event: string) => unknown, configured: (value: unknown) => boolean): Json {
  const root: Json = { ...object(settings) };
  const hooks = { ...object(root.hooks) };
  for (const event of events) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) throw new Error(`hooks.${event} must be an array`);
    const entries = Array.isArray(current) ? [...current] : [];
    if (!entries.some(configured)) entries.push(entry(event));
    hooks[event] = entries;
  }
  root.hooks = hooks;
  return root;
}

function replaceManagedEventArrays(settings: unknown, events: readonly string[], entry: (event: string) => unknown, managed: (value: unknown) => boolean): Json {
  const root: Json = { ...object(settings) };
  const hooks = { ...object(root.hooks) };
  for (const event of events) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) throw new Error(`hooks.${event} must be an array`);
    hooks[event] = [...(Array.isArray(current) ? current.filter((value) => !managed(value)) : []), entry(event)];
  }
  root.hooks = hooks;
  return root;
}

function everyEventConfigured(settings: unknown, events: readonly string[], configured: (value: unknown) => boolean) {
  const hooks = object(object(settings).hooks);
  return events.every((event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(configured));
}

function removeEventEntries(settings: unknown, events: readonly string[], managed: (value: unknown) => boolean): Json {
  const root: Json = { ...object(settings) };
  const hooks = { ...object(root.hooks) };
  for (const event of events) {
    const current = hooks[event];
    if (current === undefined) continue;
    if (!Array.isArray(current)) throw new Error(`hooks.${event} must be an array`);
    const retained = current.filter((value) => !managed(value));
    if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) root.hooks = hooks;
  else delete root.hooks;
  return root;
}

export function mergeCursorHookSettings(settings: unknown, command: string): Json {
  const merged = replaceManagedEventArrays(settings, CURSOR_EVENTS, () => ({ command }), (value) => containsCursorCommand(value));
  return { ...merged, version: typeof object(settings).version === "number" ? object(settings).version : 1 };
}

export function cursorHooksConfigured(settings: unknown, command?: string) {
  return everyEventConfigured(settings, CURSOR_EVENTS, (value) => containsCursorCommand(value, "cursor", command));
}

export function removeCursorHookSettings(settings: unknown) {
  return removeEventEntries(settings, CURSOR_EVENTS, (value) => containsCursorCommand(value));
}

export function mergeGeminiHookSettings(settings: unknown, command: string): Json {
  return replaceManagedEventArrays(settings, GEMINI_EVENTS, () => ({
    hooks: [{ type: "command", command, name: "BIG AGENT", description: "Passive local agent telemetry", timeout: 2_000 }],
  }), (value) => containsNestedCommand(value, "gemini"));
}

export function geminiHooksConfigured(settings: unknown, command?: string) {
  return everyEventConfigured(settings, GEMINI_EVENTS, (value) => containsNestedCommand(value, "gemini", command));
}

export function removeGeminiHookSettings(settings: unknown) {
  return removeEventEntries(settings, GEMINI_EVENTS, (value) => containsNestedCommand(value, "gemini"));
}

export function mergeCopilotHookSettings(settings: unknown, command: string): Json {
  const merged = replaceManagedEventArrays(settings, COPILOT_EVENTS, () => ({ type: "command", command, timeoutSec: 2 }), (value) => containsCopilotCommand(value));
  return { ...merged, version: typeof object(settings).version === "number" ? object(settings).version : 1 };
}

export function copilotHooksConfigured(settings: unknown, command?: string) {
  return everyEventConfigured(settings, COPILOT_EVENTS, (value) => containsCopilotCommand(value, command));
}

export function removeCopilotHookSettings(settings: unknown) {
  return removeEventEntries(settings, COPILOT_EVENTS, containsCopilotCommand);
}

export function mergeGrokHookSettings(settings: unknown): Json {
  const merged = mergeEventArrays(settings, GROK_EVENTS, () => ({ hooks: [{ type: "http", url: `${HOOK_URL}/grok`, timeout: 1 }] }), containsGrokHttp);
  const hooks = { ...object(merged.hooks) };
  const notifications = Array.isArray(hooks.Notification) ? [...hooks.Notification] : [];
  if (!notifications.some((entry) => object(entry).matcher === "idle_prompt" && containsGrokHttp(entry))) {
    notifications.push({ matcher: "idle_prompt", hooks: [{ type: "http", url: `${HOOK_URL}/grok`, timeout: 1 }] });
  }
  hooks.Notification = notifications;
  return { ...merged, hooks };
}

export function grokHooksConfigured(settings: unknown) {
  const hooks = object(object(settings).hooks);
  return everyEventConfigured(settings, GROK_EVENTS, containsGrokHttp)
    && Array.isArray(hooks.Notification)
    && (hooks.Notification as unknown[]).some((entry) => object(entry).matcher === "idle_prompt" && containsGrokHttp(entry));
}

export function removeGrokHookSettings(settings: unknown) {
  const withoutEvents = removeEventEntries(settings, GROK_EVENTS, containsGrokHttp);
  const root: Json = { ...withoutEvents };
  const hooks = { ...object(root.hooks) };
  const notifications = hooks.Notification;
  if (Array.isArray(notifications)) {
    const retained = notifications.filter((entry) => !(object(entry).matcher === "idle_prompt" && containsGrokHttp(entry)));
    if (retained.length) hooks.Notification = retained;
    else delete hooks.Notification;
  }
  if (Object.keys(hooks).length) root.hooks = hooks;
  else delete root.hooks;
  return root;
}

export function mergeWindsurfHookSettings(settings: unknown, command: string): Json {
  return replaceManagedEventArrays(settings, WINDSURF_EVENTS, () => ({ command, show_output: false }), (value) => containsCursorCommand(value, "windsurf"));
}

export function windsurfHooksConfigured(settings: unknown, command?: string) {
  return everyEventConfigured(settings, WINDSURF_EVENTS, (value) => containsCursorCommand(value, "windsurf", command));
}

export function removeWindsurfHookSettings(settings: unknown) {
  return removeEventEntries(settings, WINDSURF_EVENTS, (value) => containsCursorCommand(value, "windsurf"));
}

export function openCodePluginSource() {
  return `/** BIG AGENT passive local telemetry. */\nexport const BigAgentPlugin = async ({ directory }) => ({\n  event: ({ event }) => {\n    void fetch("http://127.0.0.1:19777/sources/opencode", {\n      method: "POST",\n      headers: { "content-type": "application/json" },\n      body: JSON.stringify({ ...event, cwd: directory }),\n      signal: AbortSignal.timeout(1000),\n    }).catch(() => {});\n  },\n});\n`;
}

async function readText(path: string) {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (object(error).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJson(path: string) {
  const contents = await readText(path);
  return contents?.trim() ? JSON.parse(contents) as unknown : {};
}

async function writeAtomic(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.bigagent-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

async function writeJson(path: string, value: unknown) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonSetup(
  path: string,
  configured: (value: unknown, command?: string) => boolean,
  merge: (value: unknown, command: string) => unknown,
  remove: (value: unknown, command: string) => unknown,
) {
  return {
    inspect: async (command: string) => configured(await readJson(path), command),
    install: async (command: string) => {
      const settings = await readJson(path);
      const next = merge(settings, command);
      if (!configured(settings, command)) await writeJson(path, next);
      return configured(next, command);
    },
    uninstall: async (command: string) => {
      const contents = await readText(path);
      if (!contents?.trim()) return;
      const settings = JSON.parse(contents) as unknown;
      const next = remove(settings, command);
      if (JSON.stringify(next) !== JSON.stringify(settings)) await writeJson(path, next);
    },
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function observationBridgeCommand(executable: string, script: string, provider: string) {
  if (process.platform === "win32") {
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    return `set "ELECTRON_RUN_AS_NODE=1"&& ${quote(executable)} ${quote(script)} hook ${provider} || exit /b 0`;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(executable)} ${shellQuote(script)} hook ${provider} || true`;
}

async function findFirst(names: string[], candidates: Array<string | undefined>) {
  for (const name of names) {
    const binary = await findExecutable(name, candidates);
    if (binary) return binary;
  }
  return undefined;
}

async function launchInTerminal(binary: string) {
  if (process.platform === "darwin") {
    const child = spawn("open", ["-a", "Terminal", binary], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", binary], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  for (const [name, args] of [
    ["x-terminal-emulator", ["-e", binary]],
    ["gnome-terminal", ["--", binary]],
    ["konsole", ["-e", binary]],
  ] as Array<[string, string[]]>) {
    const terminal = await findExecutable(name);
    if (!terminal) continue;
    const child = spawn(terminal, args, { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  throw new Error("No supported terminal launcher was found");
}

export class StructuredHookProvider {
  private binary?: string;
  private configured = false;
  private listening = false;
  private justConfigured = false;
  private lastEventAt?: string;
  private lastError?: string;

  constructor(
    private readonly spec: HookProviderSpec,
    private readonly bridgeCommand: string,
    private readonly onHealth: ProviderHealthListener,
  ) {}

  health(): ProviderHealth {
    const observed = Boolean(this.lastEventAt);
    const installed = Boolean(this.binary || observed);
    const connected = this.listening && (this.configured || observed) && !(this.justConfigured && this.spec.restartAfterSetup && !observed);
    const state = !installed
      ? "unavailable"
      : this.lastError
        ? "error"
        : !this.configured && !observed
          ? "needs-setup"
          : this.justConfigured && this.spec.restartAfterSetup && !observed
            ? "needs-restart"
            : observed && this.listening
              ? "ready"
              : "connecting";
    const detail = !installed
      ? `${this.spec.label} is not installed or discoverable`
      : this.lastError
        ? this.lastError
        : !this.configured && !observed
          ? `${this.spec.label} detected · official observation feed is not configured`
          : this.justConfigured && this.spec.restartAfterSetup && !observed
            ? `Observation installed · restart ${this.spec.label} or start a new session`
            : observed
              ? `Official feed connected · last event ${new Date(this.lastEventAt!).toLocaleTimeString()}`
              : this.listening
                ? "Official observation feed configured · use the agent once to verify activity"
                : "Waiting for BIG AGENT’s local telemetry receiver";
    const actions: ProviderHealth["actions"] = [];
    if (installed && !this.configured && !observed) actions.push({ id: "setup", label: this.spec.setupLabel });
    else actions.push({ id: "retry", label: "RECHECK" });
    if (this.binary) actions.push({ id: "launch", label: this.spec.launchLabel });
    if (this.configured) actions.push({ id: "remove", label: "REMOVE INTEGRATION" });
    return {
      id: this.spec.id,
      label: this.spec.label,
      transport: this.spec.transport,
      state,
      configured: this.configured,
      connected,
      listening: this.listening,
      activeSessions: 0,
      detail,
      lastEventAt: this.lastEventAt,
      actions,
    };
  }

  async start() {
    await this.refresh();
  }

  stop() {}

  setReceiverListening(listening: boolean) {
    this.listening = listening;
    this.publish();
  }

  noteEvent() {
    this.lastEventAt = new Date().toISOString();
    this.justConfigured = false;
    this.lastError = undefined;
    this.publish();
  }

  async action(action: "setup" | "retry" | "launch" | "remove") {
    if (action === "setup") {
      try {
        this.configured = await this.spec.install(this.bridgeCommand);
        this.justConfigured = this.spec.restartAfterSetup;
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      this.publish();
      return;
    }
    if (action === "retry") {
      await this.refresh();
      return;
    }
    if (action === "remove") {
      try {
        await this.spec.uninstall(this.bridgeCommand);
        this.configured = false;
        this.justConfigured = false;
        this.lastEventAt = undefined;
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      this.publish();
      return;
    }
    if (!this.binary) throw new Error(`${this.spec.label} was not found`);
    await launchInTerminal(this.binary);
  }

  private async refresh() {
    try {
      this.binary = await findFirst(this.spec.executableNames, this.spec.executableCandidates);
      this.configured = await this.spec.inspect(this.bridgeCommand);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  private publish() {
    this.onHealth(this.health());
  }
}

export function createStructuredHookProviders(executable: string, bridgeScript: string, onHealth: ProviderHealthListener) {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const cursorPath = join(home, ".cursor", "hooks.json");
  const geminiPath = join(home, ".gemini", "settings.json");
  const copilotPath = join(process.env.COPILOT_HOME || join(home, ".copilot"), "hooks", "big-agent.json");
  const grokPath = join(process.env.GROK_HOME || join(home, ".grok"), "hooks", "big-agent.json");
  const windsurfPath = join(home, ".codeium", "windsurf", "hooks.json");
  const openCodePath = join(configHome, "opencode", "plugins", "big-agent.js");
  const openCodeSetup = {
    inspect: async (_command: string) => (await readText(openCodePath)) === openCodePluginSource(),
    install: async (_command: string) => {
      if ((await readText(openCodePath)) !== openCodePluginSource()) await writeAtomic(openCodePath, openCodePluginSource());
      return true;
    },
    uninstall: async (_command: string) => {
      const source = await readText(openCodePath);
      if (source?.includes("BIG AGENT passive local telemetry")) await rm(openCodePath, { force: true });
    },
  };
  const specs: HookProviderSpec[] = [
    {
      id: "grok", label: "GROK BUILD", transport: "HTTP LIFECYCLE HOOKS", executableNames: ["grok"],
      executableCandidates: [process.env.GROK_CLI_PATH, join(home, ".local", "bin", "grok"), join(home, ".grok", "bin", "grok")],
      setupLabel: "SET UP GROK", launchLabel: "OPEN GROK", restartAfterSetup: true,
      ...jsonSetup(grokPath, grokHooksConfigured, (value) => mergeGrokHookSettings(value), (value) => removeGrokHookSettings(value)),
    },
    {
      id: "cursor", label: "CURSOR", transport: "THOUGHT + LIFECYCLE HOOKS", executableNames: ["cursor"],
      executableCandidates: [process.env.CURSOR_PATH, "/usr/bin/cursor", "/usr/local/bin/cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
      setupLabel: "SET UP CURSOR", launchLabel: "OPEN CURSOR", restartAfterSetup: false,
      ...jsonSetup(cursorPath, cursorHooksConfigured, mergeCursorHookSettings, (value) => removeCursorHookSettings(value)),
    },
    {
      id: "gemini", label: "GEMINI CLI", transport: "LIFECYCLE HOOKS + OTEL", executableNames: ["gemini"],
      executableCandidates: [process.env.GEMINI_CLI_PATH, join(home, ".local", "bin", "gemini")],
      setupLabel: "SET UP GEMINI", launchLabel: "OPEN GEMINI", restartAfterSetup: true,
      ...jsonSetup(geminiPath, geminiHooksConfigured, mergeGeminiHookSettings, (value) => removeGeminiHookSettings(value)),
    },
    {
      id: "copilot", label: "COPILOT CLI", transport: "OFFICIAL LIFECYCLE HOOKS", executableNames: ["copilot"],
      executableCandidates: [process.env.COPILOT_CLI_PATH, join(home, ".local", "bin", "copilot")],
      setupLabel: "SET UP COPILOT", launchLabel: "OPEN COPILOT", restartAfterSetup: true,
      ...jsonSetup(copilotPath, copilotHooksConfigured, mergeCopilotHookSettings, (value) => removeCopilotHookSettings(value)),
    },
    {
      id: "windsurf", label: "WINDSURF", transport: "CASCADE LIFECYCLE HOOKS", executableNames: ["windsurf"],
      executableCandidates: [process.env.WINDSURF_PATH, "/usr/bin/windsurf", "/usr/local/bin/windsurf", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],
      setupLabel: "SET UP WINDSURF", launchLabel: "OPEN WINDSURF", restartAfterSetup: true,
      ...jsonSetup(windsurfPath, windsurfHooksConfigured, mergeWindsurfHookSettings, (value) => removeWindsurfHookSettings(value)),
    },
    {
      id: "opencode", label: "OPENCODE", transport: "GLOBAL PLUGIN + SSE", executableNames: ["opencode"],
      executableCandidates: [process.env.OPENCODE_PATH, join(home, ".opencode", "bin", "opencode"), join(home, ".local", "bin", "opencode")],
      setupLabel: "SET UP OPENCODE", launchLabel: "OPEN OPENCODE", restartAfterSetup: true,
      ...openCodeSetup,
    },
  ];
  return specs.map((spec) => new StructuredHookProvider(
    spec,
    observationBridgeCommand(executable, bridgeScript, spec.id),
    onHealth,
  ));
}
