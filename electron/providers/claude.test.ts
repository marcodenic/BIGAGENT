import { describe, expect, it } from "vitest";
import { CLAUDE_HOOK_EVENTS, claudeHooksConfigured, claudeRegistryEvent, mergeClaudeHookSettings, removeClaudeHookSettings } from "./claude";

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
    expect(configured.allowedHttpHookUrls).toContain("http://127.0.0.1:19777/hooks/claude");
    expect(claudeHooksConfigured(configured)).toBe(true);
    expect(Object.keys(configured.hooks as object)).toEqual(expect.arrayContaining([...CLAUDE_HOOK_EVENTS]));
    expect(mergeClaudeHookSettings(configured)).toEqual(configured);
    expect(removeClaudeHookSettings(configured)).toEqual(original);
  });

  it("keeps an explicit native session title separate from the Claude agent name", () => {
    const event = claudeRegistryEvent({
      sessionId: "claude-1",
      state: "working",
      cwd: "/workspace/BIGAGENT",
      name: "reviewer",
      customTitle: "Audit provider lifecycle",
    });

    expect(event?.meta).toMatchObject({
      workstreamName: "BIGAGENT",
      sessionTitle: "Audit provider lifecycle",
      agentName: "reviewer",
    });
  });
});

describe("Claude registry transitions and shared hook groups", () => {
  it("does not invent activity for an unknown registry state", () => {
    expect(claudeRegistryEvent({ sessionId: "session-1", state: "unknown" })).toBeUndefined();
  });

  it("delivers repeated working and blocked states as new observations", async () => {
    const { TelemetryHub } = await import("../telemetry/hub");
    const hub = new TelemetryHub();
    const observed: Array<string | undefined> = [];
    hub.onEvent((event) => observed.push(event.status));
    let previous: string | undefined;
    for (const state of ["working", "blocked", "working", "blocked", "done"]) {
      const event = claudeRegistryEvent({ sessionId: "session-1", state, pid: 123 }, previous)!;
      const envelope = { source: "claude-agents", product: "claude", transport: "agents-json", format: "protocol" as const, payload: event };
      expect(hub.ingest(envelope)).toHaveLength(1);
      expect(hub.ingest(envelope)).toHaveLength(0);
      previous = state;
    }
    expect(observed).toEqual(["thinking", "waiting", "thinking", "waiting", "complete"]);
  });

  it("preserves unrelated hooks and matcher metadata in a mixed group", () => {
    const user = { type: "command", command: "./audit.sh" };
    const original = { hooks: { PreToolUse: [{ matcher: "Bash", extra: true, hooks: [user,
      { type: "http", url: "http://127.0.0.1:19777/hooks/claude" },
    ] }] } };
    const expected = { hooks: { PreToolUse: [{ matcher: "Bash", extra: true, hooks: [user] }] } };
    expect(removeClaudeHookSettings(original)).toEqual(expected);
    expect(removeClaudeHookSettings(mergeClaudeHookSettings(original))).toEqual(expected);
    expect(original.hooks.PreToolUse[0].hooks).toHaveLength(2);
  });
});
