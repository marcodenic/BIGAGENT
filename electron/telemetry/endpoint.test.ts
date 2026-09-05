import { afterEach, expect, it, vi } from "vitest";
import { telemetryPort, telemetryUrl } from "./endpoint";
import { mergeClaudeHookSettings, claudeHooksConfigured, removeClaudeHookSettings } from "../providers/claude";
import { mergeGrokHookSettings, grokHooksConfigured, removeGrokHookSettings, observationBridgeCommand, openCodePluginSource } from "../providers/structured-hooks";

afterEach(() => vi.unstubAllEnvs());

it("generates every integration for the configured receiver and migrates old HTTP endpoints", () => {
  vi.stubEnv("BIG_AGENT_PORT", "19777");
  const oldClaude = mergeClaudeHookSettings({ allowedHttpHookUrls: ["https://example.com/audit"] });
  const oldGrok = mergeGrokHookSettings({});
  vi.stubEnv("BIG_AGENT_PORT", "23456");
  expect(telemetryPort()).toBe(23456);
  expect(telemetryUrl("/event")).toBe("http://127.0.0.1:23456/event");
  expect(claudeHooksConfigured(oldClaude)).toBe(false);
  expect(grokHooksConfigured(oldGrok)).toBe(false);
  const claude = mergeClaudeHookSettings(oldClaude);
  const grok = mergeGrokHookSettings(oldGrok);
  expect(claudeHooksConfigured(claude)).toBe(true);
  expect(grokHooksConfigured(grok)).toBe(true);
  expect(JSON.stringify(claude)).not.toContain(":19777");
  expect(JSON.stringify(grok)).not.toContain(":19777");
  expect(claude.allowedHttpHookUrls).toEqual(["https://example.com/audit", "http://127.0.0.1:23456/hooks/claude"]);
  expect(removeClaudeHookSettings(oldClaude)).toEqual({ allowedHttpHookUrls: ["https://example.com/audit"] });
  expect(removeGrokHookSettings(oldGrok)).toEqual({});
  for (const provider of ["cursor", "gemini", "copilot", "windsurf"]) {
    for (const platform of ["linux", "win32"] as const) {
      const command = observationBridgeCommand("/opt/electron", "/opt/big-agent.mjs", provider, platform);
      const script = platform === "win32"
        ? Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le")
        : command;
      expect(script).toContain("http://127.0.0.1:23456/event");
    }
  }
  expect(openCodePluginSource()).toContain("http://127.0.0.1:23456/sources/opencode");
});

it("uses a caller-supplied Claude URL in both the hook and allowlist", () => {
  const url = "http://127.0.0.1:24567/hooks/claude";
  const result = mergeClaudeHookSettings({ allowedHttpHookUrls: [] }, url);
  expect(result.allowedHttpHookUrls).toEqual([url]);
  expect(claudeHooksConfigured(result, url)).toBe(true);
});
