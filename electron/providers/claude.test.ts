import { describe, expect, it } from "vitest";
import { CLAUDE_HOOK_EVENTS, claudeHooksConfigured, mergeClaudeHookSettings } from "./claude";

describe("Claude HTTP hook setup", () => {
  it("preserves user hooks and installs every observation event idempotently", () => {
    const original = {
      permissions: { allow: ["Read"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }] },
      allowedHttpHookUrls: ["https://hooks.example.com/*"],
    };
    const configured = mergeClaudeHookSettings(original);
    expect(configured.permissions).toEqual(original.permissions);
    expect((configured.hooks as Record<string, unknown[]>).PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(configured.allowedHttpHookUrls).toContain("http://127.0.0.1:*");
    expect(claudeHooksConfigured(configured)).toBe(true);
    expect(Object.keys(configured.hooks as object)).toEqual(expect.arrayContaining([...CLAUDE_HOOK_EVENTS]));
    expect(mergeClaudeHookSettings(configured)).toEqual(configured);
  });
});

