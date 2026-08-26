import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexHookBridgeConfigured, containsBigAgentCodexHook, removeBigAgentCodexHooks } from "./codex-authority";

describe("Codex source authority", () => {
  it("detects the BIG AGENT Codex bridge without accepting unrelated hooks", () => {
    expect(containsBigAgentCodexHook({ hooks: { Stop: [{ hooks: [{ command: "/opt/big-agent.mjs hook codex" }] }] } })).toBe(true);
    expect(containsBigAgentCodexHook({ hooks: { Stop: [{ hooks: [{ command: "/opt/other.mjs hook codex" }] }] } })).toBe(false);
  });

  it("detects a historical bridge before its App Server migration", () => {
    const root = mkdtempSync(join(tmpdir(), "big-agent-authority-"));
    try {
      writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "node /workspace/big-agent.mjs hook codex" }] }] } }));
      expect(codexHookBridgeConfigured(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("removes only BIG AGENT-owned actions and preserves unrelated hooks", () => {
    const original = {
      custom: true,
      hooks: {
        Stop: [{
          matcher: ".*",
          hooks: [
            { type: "command", command: "node /workspace/big-agent.mjs hook codex", timeout: 3 },
            { type: "command", command: "/opt/my-hook" },
          ],
        }],
        SessionStart: [{ hooks: [{ type: "command", command: "node /workspace/big-agent.mjs hook codex" }] }],
      },
    };
    const migrated = removeBigAgentCodexHooks(original);
    expect(migrated.removed).toBe(2);
    expect(migrated.value).toEqual({
      custom: true,
      hooks: {
        Stop: [{ matcher: ".*", hooks: [{ type: "command", command: "/opt/my-hook" }] }],
      },
    });
    expect(original.hooks.SessionStart).toHaveLength(1);
  });
});
