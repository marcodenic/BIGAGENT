import spawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AgentEvent, AgentStatus, EventKind } from "../../src/core/protocol";
import type { TelemetryHub } from "../telemetry/hub";
import { launchInTerminal } from "./launch";
import { findExecutable } from "./executables";
import type { ProviderHealth, ProviderHealthListener } from "./types";
import { removeNestedHooks } from "./nested-hooks";
import { isLocalTelemetryUrl, telemetryUrl } from "../telemetry/endpoint";

type Json = Record<string, unknown>;

const claudeHookUrl = () => telemetryUrl("/hooks/claude");
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "MessageDisplay",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "PreCompact",
  "PostCompact",
] as const;

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function containsBigAgentHook(value: unknown, url = claudeHookUrl()) {
  const entry = object(value);
  return (Array.isArray(entry.hooks) ? entry.hooks : []).some((hook) => {
    const config = object(hook);
    return config.type === "http" && config.url === url;
  });
}

export function claudeHooksConfigured(settings: unknown, url = claudeHookUrl()) {
  const root = object(settings);
  const hooks = object(root.hooks);
  return CLAUDE_HOOK_EVENTS.every((event) => {
    const entries = hooks[event];
    return Array.isArray(entries) && entries.some((entry) => containsBigAgentHook(entry, url));
  });
}

export function mergeClaudeHookSettings(settings: unknown, url = claudeHookUrl()) {
  const root = removeClaudeHookSettings(settings, url);
  const existingHooks = object(root.hooks);
  const hooks: Json = { ...existingHooks };
  for (const event of CLAUDE_HOOK_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error(`Claude hooks.${event} must be an array`);
    const entries = Array.isArray(existing) ? [...existing] : [];
    if (!entries.some((entry) => containsBigAgentHook(entry, url))) {
      entries.push({ hooks: [{ type: "http", url, timeout: 2 }] });
    }
    hooks[event] = entries;
  }
  root.hooks = hooks;
  if (root.allowedHttpHookUrls !== undefined) {
    if (!Array.isArray(root.allowedHttpHookUrls)) throw new Error("Claude allowedHttpHookUrls must be an array");
    const allowlist = root.allowedHttpHookUrls.filter((value): value is string => typeof value === "string");
    if (!allowlist.includes(url)) {
      root.allowedHttpHookUrls = [...allowlist, url];
    }
  }
  return root;
}

export function removeClaudeHookSettings(settings: unknown, url = claudeHookUrl()) {
  const ownedUrl = (value: unknown) => value === url || isLocalTelemetryUrl(value, "/hooks/claude");
  const root = removeNestedHooks(settings, CLAUDE_HOOK_EVENTS, (hook) => hook.type === "http" && ownedUrl(hook.url));
  if (Array.isArray(root.allowedHttpHookUrls)) {
    root.allowedHttpHookUrls = root.allowedHttpHookUrls.filter((value) => !ownedUrl(value));
  }
  return root;
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.bigagent-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function commandOutput(binary: string, args: string[], timeoutMs = 5_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr!.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${args.join(" ")} exited with code ${code ?? -1}`));
    });
  });
}

function agentSessionId(entry: Json) {
  return text(entry.sessionId, entry.session_id) ?? (text(entry.id) ? `claude:${text(entry.id)}` : undefined);
}

export function claudeRegistryEvent(entry: Json, previousState?: string): AgentEvent | undefined {
  const sessionId = agentSessionId(entry);
  const rawState = text(entry.state, entry.status)?.toLowerCase();
  if (!sessionId || !rawState) return undefined;
  const cwd = text(entry.cwd) ?? "";
  const waitingFor = entry.waitingFor;
  const waitingDetail = typeof waitingFor === "string"
    ? waitingFor
    : text(object(waitingFor).question, object(waitingFor).message, object(waitingFor).reason);
  let status: AgentStatus;
  let kind: EventKind;
  let label: string;
  let detail: string;
  if (rawState === "blocked") {
    status = "waiting";
    kind = "input.requested";
    label = "NEEDS YOU";
    detail = waitingDetail || "Claude needs input";
  } else if (rawState === "done") {
    status = "complete";
    kind = "session.end";
    label = "DONE";
    detail = text(entry.summary, entry.result) || "Claude session completed";
  } else if (rawState === "failed") {
    status = "error";
    kind = "error";
    label = "SOMETHING BROKE";
    detail = text(entry.error, entry.summary) || "Claude session failed";
  } else if (rawState === "stopped") {
    status = "complete";
    kind = "session.end";
    label = "STOPPED";
    detail = "Claude session stopped";
  } else {
    status = "thinking";
    kind = previousState ? "activity" : "session.start";
    label = "THINKING";
    detail = text(entry.summary, entry.status) || "Claude is working";
  }
  return {
    version: 1,
    // Reconciliation already skips unchanged entries. A later return to the
    // same state is a new observation, not a duplicate of the earlier event.
    id: `claude-agents-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    kind,
    status,
    label,
    detail,
    phase: rawState === "blocked" ? "waiting" : rawState === "working" ? "planning" : rawState === "failed" ? "failed" : "completing",
    meta: {
      source: "claude-agents",
      product: "claude",
      transport: "agents-json",
      sessionId,
      workstreamId: sessionId,
      workstreamName: basename(cwd) || text(entry.name) || "CLAUDE",
      project: cwd,
      sessionTitle: text(entry.sessionTitle, entry.session_title, entry.customTitle, entry.custom_title, entry.title),
      agentName: text(entry.name) || "Claude",
      modelProvider: "anthropic",
      model: text(entry.model) || "claude",
      startedAtMs: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
      lastMessage: rawState === "done" ? text(entry.summary, entry.result) : undefined,
      registryId: entry.id,
      registryState: rawState,
    },
  };
}

export class ClaudeProvider {
  private binary?: string;
  private configured = false;
  private listening = false;
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private readonly previous = new Map<string, Json>();
  private lastEventAt?: string;
  private lastReconciledAt?: string;
  private lastError?: string;

  constructor(private readonly hub: TelemetryHub, private readonly onHealth: ProviderHealthListener) {}

  health(): ProviderHealth {
    const hookObserved = Boolean(this.lastEventAt);
    const observable = Boolean(this.configured && this.listening && (this.binary || hookObserved));
    const state = !this.configured
        ? "needs-setup"
        : this.lastError && !this.listening
          ? "error"
          : observable
            ? "ready"
            : !this.binary
              ? "unavailable"
              : "connecting";
    const detail = !this.configured
      ? "Claude hooks are not installed"
      : !this.binary && hookObserved
        ? `Claude Desktop hook feed connected · last event ${new Date(this.lastEventAt!).toLocaleTimeString()}`
      : !this.binary
        ? "Hooks installed · open Claude Desktop Code or install Claude Code, then recheck"
        : !this.listening
          ? "Waiting for the local hook receiver"
          : this.lastError
            ? `Hook receiver listening · reconciliation: ${this.lastError}`
            : this.lastEventAt
              ? `Hook receiver listening · last event ${new Date(this.lastEventAt).toLocaleTimeString()}`
              : this.lastReconciledAt
                ? "Hook receiver listening · agent registry connected"
                : "Hook receiver listening · waiting for Claude";
    const actions: ProviderHealth["actions"] = [];
    if (!this.configured) actions.push({ id: "setup", label: "SET UP CLAUDE" });
    else actions.push({ id: "retry", label: "RECHECK" });
    if (this.binary) {
      actions.push({ id: "launch", label: "OPEN CLAUDE" });
    }
    if (this.configured) actions.push({ id: "remove", label: "REMOVE INTEGRATION" });
    return {
      id: "claude",
      label: "CLAUDE",
      transport: "HTTP HOOKS + AGENTS",
      state,
      configured: this.configured,
      connected: observable,
      listening: this.listening,
      activeSessions: [...this.previous.values()].filter((entry) => ["working", "blocked"].includes(text(entry.state)?.toLowerCase() ?? "")).length,
      detail,
      lastEventAt: this.lastEventAt,
      actions,
    };
  }

  async start() {
    this.stopped = false;
    this.lastError = undefined;
    this.configured = await this.hooksConfigured().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    });
    this.binary = await findExecutable("claude", [process.env.CLAUDE_CLI_PATH]);
    this.publishHealth();
    if (!this.binary) return;
    await this.reconcile().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    this.ensurePolling();
    this.publishHealth();
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private ensurePolling() {
    if (!this.binary || this.stopped || this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.reconcile(), 3_000);
    this.pollTimer.unref();
  }

  setReceiverListening(listening: boolean) {
    this.listening = listening;
    this.publishHealth();
  }

  noteHookEvent() {
    this.lastEventAt = new Date().toISOString();
    this.publishHealth();
  }

  async action(action: "setup" | "retry" | "launch" | "remove") {
    if (action === "setup") {
      this.configured = await this.installHooks();
      this.publishHealth();
      return;
    }
    if (action === "retry") {
      this.configured = await this.hooksConfigured();
      this.binary = await findExecutable("claude", [process.env.CLAUDE_CLI_PATH]);
      if (this.binary) await this.reconcile();
      this.ensurePolling();
      this.publishHealth();
      return;
    }
    if (action === "remove") {
      await this.uninstallHooks();
      this.configured = false;
      this.lastEventAt = undefined;
      this.publishHealth();
      return;
    }
    await this.launch();
  }

  private async readSettings() {
    const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const settingsPath = join(configRoot, "settings.json");
    try {
      const contents = await readFile(settingsPath, "utf8");
      return { settingsPath, settings: contents.trim() ? JSON.parse(contents) as unknown : {} };
    } catch (error) {
      const code = object(error).code;
      if (code !== "ENOENT") throw error;
      return { settingsPath, settings: {} as unknown };
    }
  }

  private async hooksConfigured() {
    const { settings } = await this.readSettings();
    return claudeHooksConfigured(settings);
  }

  private async installHooks() {
    const { settingsPath, settings } = await this.readSettings();
    const merged = mergeClaudeHookSettings(settings);
    if (JSON.stringify(settings) !== JSON.stringify(merged)) await writeAtomic(settingsPath, merged);
    return claudeHooksConfigured(merged);
  }

  private async uninstallHooks() {
    const { settingsPath, settings } = await this.readSettings();
    const restored = removeClaudeHookSettings(settings);
    if (JSON.stringify(restored) !== JSON.stringify(settings)) await writeAtomic(settingsPath, restored);
  }

  private async reconcile() {
    if (!this.binary || this.stopped || this.polling) return;
    this.polling = true;
    try {
      const output = await commandOutput(this.binary, ["agents", "--json"]);
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error("claude agents --json did not return an array");
      const current = new Map<string, Json>();
      for (const value of parsed) {
        const entry = object(value);
        const sessionId = agentSessionId(entry);
        if (!sessionId) continue;
        current.set(sessionId, entry);
        const previous = this.previous.get(sessionId);
        if (JSON.stringify(previous) !== JSON.stringify(entry)) this.ingestRegistry(entry, text(previous?.state));
      }
      const missing = [...this.previous.keys()].filter((id) => !current.has(id));
      if (missing.length) await this.reconcileMissing(missing, current);
      this.previous.clear();
      for (const [id, entry] of current) this.previous.set(id, entry);
      this.lastReconciledAt = new Date().toISOString();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.polling = false;
      this.publishHealth();
    }
  }

  private async reconcileMissing(missing: string[], current: Map<string, Json>) {
    if (!this.binary) return;
    let all: Json[] = [];
    try {
      const parsed = JSON.parse(await commandOutput(this.binary, ["agents", "--json", "--all"]));
      if (Array.isArray(parsed)) all = parsed.map(object);
    } catch {
      // Active-list disappearance is still authoritative; --all only improves
      // the terminal reason (done, failed, or stopped).
    }
    for (const sessionId of missing) {
      const terminal = all.find((entry) => agentSessionId(entry) === sessionId) ?? { ...this.previous.get(sessionId), state: "done" };
      this.ingestRegistry(terminal, text(this.previous.get(sessionId)?.state));
    }
  }

  private ingestRegistry(entry: Json, previousState?: string) {
    const event = claudeRegistryEvent(entry, previousState);
    if (!event) return;
    this.hub.ingest({ source: "claude-agents", product: "claude", transport: "agents-json", format: "protocol", payload: event });
  }

  private async launch() {
    if (!this.binary) throw new Error("Claude CLI was not found");
    await launchInTerminal(this.binary);
  }

  private publishHealth() {
    this.onHealth(this.health());
  }
}
