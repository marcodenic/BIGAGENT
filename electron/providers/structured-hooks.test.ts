import { describe, expect, it } from "vitest";
import {
  copilotHooksConfigured,
  cursorHooksConfigured,
  geminiHooksConfigured,
  grokHooksConfigured,
  mergeCopilotHookSettings,
  mergeCursorHookSettings,
  mergeGeminiHookSettings,
  mergeGrokHookSettings,
  mergeWindsurfHookSettings,
  observationBridgeCommand,
  openCodePluginSource,
  removeCopilotHookSettings,
  removeCursorHookSettings,
  removeGeminiHookSettings,
  removeGrokHookSettings,
  removeWindsurfHookSettings,
  windsurfHooksConfigured,
} from "./structured-hooks";

const bridge = "ELECTRON_RUN_AS_NODE=1 '/opt/BIG AGENT/electron' '/opt/BIG AGENT/big-agent.mjs' hook provider || true";

describe("official structured provider setup", () => {
  it("preserves Cursor hooks and installs the narrative events idempotently", () => {
    const original = { custom: true, hooks: { preToolUse: [{ command: "./audit.sh" }] } };
    const configured = mergeCursorHookSettings(original, bridge.replace("provider", "cursor"));

    expect(configured.custom).toBe(true);
    expect((configured.hooks as Record<string, unknown[]>).preToolUse[0]).toEqual({ command: "./audit.sh" });
    expect((configured.hooks as Record<string, unknown[]>).afterAgentThought).toHaveLength(1);
    expect((configured.hooks as Record<string, unknown[]>).afterAgentResponse).toHaveLength(1);
    expect(cursorHooksConfigured(configured)).toBe(true);
    expect(mergeCursorHookSettings(configured, bridge.replace("provider", "cursor"))).toEqual(configured);
    expect(removeCursorHookSettings(configured)).toEqual({ ...original, version: 1 });
  });

  it("replaces stale BIG AGENT hook commands without touching user hooks", () => {
    const stale = "ELECTRON_RUN_AS_NODE=1 '/tmp/.mount_old/electron' '/tmp/.mount_old/big-agent.mjs' hook cursor || true";
    const current = bridge.replace("provider", "cursor");
    const original = { hooks: { sessionStart: [{ command: "./audit.sh" }, { command: stale }] } };
    const configured = mergeCursorHookSettings(original, current);
    const sessionStart = (configured.hooks as Record<string, Array<{ command: string }>>).sessionStart;

    expect(sessionStart).toEqual([{ command: "./audit.sh" }, { command: current }]);
    expect(cursorHooksConfigured(configured, current)).toBe(true);
    expect(JSON.stringify(configured)).not.toContain(".mount_old");
  });

  it("preserves Gemini settings and installs every command hook idempotently", () => {
    const original = { theme: "dark", hooks: { BeforeTool: [{ hooks: [{ type: "command", command: "./audit.sh" }] }] } };
    const command = bridge.replace("provider", "gemini");
    const configured = mergeGeminiHookSettings(original, command);

    expect(configured.theme).toBe("dark");
    expect((configured.hooks as Record<string, unknown[]>).BeforeTool[0]).toEqual(original.hooks.BeforeTool[0]);
    expect(geminiHooksConfigured(configured)).toBe(true);
    expect(mergeGeminiHookSettings(configured, command)).toEqual(configured);
    expect(removeGeminiHookSettings(configured)).toEqual(original);
  });

  it("preserves Copilot hooks and installs fail-open commands idempotently", () => {
    const original = { hooks: { PreToolUse: [{ type: "command", bash: "./audit.sh" }] } };
    const command = bridge.replace("provider", "copilot");
    const configured = mergeCopilotHookSettings(original, command);

    expect((configured.hooks as Record<string, unknown[]>).PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(copilotHooksConfigured(configured)).toBe(true);
    expect(JSON.stringify(configured)).toContain("|| true");
    expect(mergeCopilotHookSettings(configured, command)).toEqual(configured);
    expect(removeCopilotHookSettings(configured)).toEqual({ ...original, version: 1 });
  });

  it("installs Grok HTTP lifecycle hooks plus its authoritative idle backstop", () => {
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "./audit.sh" }] }] } };
    const configured = mergeGrokHookSettings(original);
    const notification = (configured.hooks as Record<string, Array<Record<string, unknown>>>).Notification;

    expect((configured.hooks as Record<string, unknown[]>).Stop[0]).toEqual(original.hooks.Stop[0]);
    expect(notification).toEqual(expect.arrayContaining([expect.objectContaining({ matcher: "idle_prompt" })]));
    expect(grokHooksConfigured(configured)).toBe(true);
    expect(mergeGrokHookSettings(configured)).toEqual(configured);
    expect(removeGrokHookSettings(configured)).toEqual(original);
  });

  it("preserves Windsurf hooks without enabling transcript capture", () => {
    const original = { hooks: { pre_read_code: [{ command: "./audit.sh" }] } };
    const command = bridge.replace("provider", "windsurf");
    const configured = mergeWindsurfHookSettings(original, command);

    expect((configured.hooks as Record<string, unknown[]>).pre_read_code[0]).toEqual(original.hooks.pre_read_code[0]);
    expect(windsurfHooksConfigured(configured)).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("include_transcript");
    expect(mergeWindsurfHookSettings(configured, command)).toEqual(configured);
    expect(removeWindsurfHookSettings(configured)).toEqual(original);
  });

  it("uses a bounded fail-open bridge and OpenCode global event plugin", () => {
    const command = observationBridgeCommand("/opt/BIG AGENT/electron", "/opt/BIG AGENT/big-agent.mjs", "cursor");
    const plugin = openCodePluginSource();

    expect(command).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(command).toMatch(process.platform === "win32" ? /^powershell\.exe .* -EncodedCommand / : /\|\| true$/);
    expect(plugin).toContain("/sources/opencode");
    expect(plugin).toContain("AbortSignal.timeout(1000)");
    expect(plugin).toContain("catch(() => {})");
  });
});

describe("mixed nested hook ownership", () => {
  it("preserves Gemini user hooks through command replacement and removal", () => {
    const user = { type: "command", command: "./audit.sh" };
    const original = { theme: "dark", hooks: { BeforeTool: [{ matcher: "read_file", hooks: [
      user, { type: "command", command: "node /tmp/old/big-agent.mjs hook gemini" },
    ] }] } };
    const retained = { ...original, hooks: { BeforeTool: [{ matcher: "read_file", hooks: [user] }] } };
    expect(removeGeminiHookSettings(original)).toEqual(retained);
    const configured = mergeGeminiHookSettings(original, bridge.replace("provider", "gemini"));
    expect((configured.hooks as Record<string, unknown[]>).BeforeTool[0]).toEqual(retained.hooks.BeforeTool[0]);
    expect(removeGeminiHookSettings(configured)).toEqual(retained);
    expect(original.hooks.BeforeTool[0].hooks).toHaveLength(2);
  });

  it("preserves Grok user hooks inside lifecycle and idle notification groups", () => {
    const user = { type: "command", command: "./audit.sh" };
    const managed = { type: "http", url: "http://127.0.0.1:19777/hooks/grok" };
    const original = { hooks: {
      Stop: [{ matcher: "*", hooks: [user, managed] }],
      Notification: [{ matcher: "idle_prompt", hooks: [managed, user] }],
    } };
    const retained = { hooks: {
      Stop: [{ matcher: "*", hooks: [user] }],
      Notification: [{ matcher: "idle_prompt", hooks: [user] }],
    } };
    expect(removeGrokHookSettings(original)).toEqual(retained);
    expect(removeGrokHookSettings(mergeGrokHookSettings(original))).toEqual(retained);
  });
});

it("generates removable Windows hooks with quoted paths and UTF-8 input", () => {
  const command = observationBridgeCommand("C:\\Program Files\\BIG AGENT\\BIG AGENT.exe", "C:\\Users\\O'Brien\\big-agent.mjs", "gemini", "win32");
  expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const source = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  expect(source).toContain("O''Brien");
  expect(source).toContain("UTF8Encoding");
  expect(source).toContain("ReadToEnd()");
  expect(source).toContain("exit 0");
  const settings = mergeGeminiHookSettings({}, command);
  expect(geminiHooksConfigured(settings, command)).toBe(true);
  expect(geminiHooksConfigured(removeGeminiHookSettings(settings), command)).toBe(false);
});

it.runIf(process.platform === "win32")("runs a Windows hook with Unicode input and apostrophes in its path", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "BIG AGENT O'Brien-"));
  try {
    const script = join(directory, "big-agent.mjs");
    await writeFile(script, `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data); process.stdin.on('end', () => { console.log(JSON.stringify({input: JSON.parse(input), args: process.argv.slice(2)})); process.exitCode = 9; });`);
    const command = observationBridgeCommand(process.execPath, script, "gemini", "win32");
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("powershell.exe", command.split(" ").slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", data => output += data);
      child.stderr.resume(); child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
      child.stdin.end(JSON.stringify({ detail: "日本語 · café" }));
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ input: { detail: "日本語 · café" }, args: ["hook", "gemini"] });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);
