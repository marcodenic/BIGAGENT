import { describe, expect, it } from "vitest";
import { normalizeTelemetry, type TelemetryEnvelope } from "../../electron/telemetry/normalizers";
import type { AgentEvent } from "./protocol";
import { activeBoardWorkstreams, applySessionEvent, groupWorkstreams, type AgentSession } from "./workstreams";

function normalize(format: TelemetryEnvelope["format"], payload: unknown, source = "codex-hooks", receivedAt = 1_000) {
  return normalizeTelemetry({ source, product: "codex", transport: format, format, payload, receivedAt })[0];
}

function apply(sessions: Record<string, AgentSession>, event: AgentEvent, now: number) {
  return applySessionEvent(sessions, event, now, String(event.meta?.source ?? "protocol"));
}

describe("end-to-end lifecycle projection", () => {
  it("separates session availability, transient turn completion, and true session completion", () => {
    let sessions: Record<string, AgentSession> = {};
    sessions = apply(sessions, normalize("hook", { hook_event_name: "SessionStart", session_id: "root", source: "startup" }), 1_000);
    expect(groupWorkstreams(sessions, 1_000)).toEqual([]);

    sessions = apply(sessions, normalize("hook", { hook_event_name: "UserPromptSubmit", session_id: "root", turn_id: "turn-1" }), 2_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 2_000))[0].agents[0].state.status).toBe("thinking");

    sessions = apply(sessions, normalize("hook", { hook_event_name: "PreToolUse", session_id: "root", turn_id: "turn-1", tool_use_id: "tool-1", tool_name: "Bash", tool_input: { command: "pnpm test" } }), 3_000);
    expect(sessions.root.state).toMatchObject({ status: "command", command: "pnpm test" });

    sessions = apply(sessions, normalize("hook", { hook_event_name: "Stop", session_id: "root", turn_id: "turn-1" }), 4_000);
    expect(sessions.root.state).toMatchObject({ status: "complete", label: "DONE", completionScope: "turn" });
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 4_000))[0].agents.map((agent) => agent.id)).toEqual(["root"]);
    expect(groupWorkstreams(sessions, 24_001)).toEqual([]);

    sessions = apply(sessions, normalize("hook", { hook_event_name: "SessionEnd", session_id: "root", reason: "other" }), 5_000);
    expect(groupWorkstreams(sessions, 5_000)[0]).toMatchObject({ status: "complete", agents: [{ id: "root", state: { status: "complete", completionScope: "session" } }] });
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 5_000))).toEqual([]);
  });

  it("keeps completed child and parent turns visible for the terminal TTL", () => {
    let sessions: Record<string, AgentSession> = {};
    sessions = apply(sessions, normalize("hook", { hook_event_name: "UserPromptSubmit", session_id: "root", turn_id: "turn-1" }), 1_000);
    sessions = apply(sessions, normalize("hook", { hook_event_name: "SubagentStart", session_id: "root", turn_id: "turn-1", agent_id: "child", agent_type: "reviewer" }), 2_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 2_000))[0].agents).toHaveLength(2);

    sessions = apply(sessions, normalize("hook", { hook_event_name: "SubagentStop", session_id: "root", turn_id: "turn-1", agent_id: "child", agent_type: "reviewer" }), 3_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 3_000))[0].agents.map((agent) => [agent.id, agent.state.status])).toEqual([
      ["root", "thinking"],
      ["child", "complete"],
    ]);

    sessions = apply(sessions, normalize("hook", { hook_event_name: "Stop", session_id: "root", turn_id: "turn-1" }), 4_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 4_000))[0].agents.map((agent) => [agent.id, agent.state.status])).toEqual([
      ["root", "complete"],
      ["child", "complete"],
    ]);
    expect(groupWorkstreams(sessions, 24_001)).toEqual([]);
  });

  it("handles repeated App Server turns without reviving a closed thread", () => {
    let sessions: Record<string, AgentSession> = {};
    sessions = apply(sessions, normalize("codex-app-server", { method: "thread/started", params: { thread: { id: "root", sessionId: "root" } } }, "codex-app-server"), 1_000);
    expect(groupWorkstreams(sessions, 1_000)).toEqual([]);

    sessions = apply(sessions, normalize("codex-app-server", { method: "turn/started", params: { threadId: "root", turn: { id: "turn-1", status: "inProgress" } } }, "codex-app-server"), 2_000);
    sessions = apply(sessions, normalize("codex-app-server", { method: "turn/completed", params: { threadId: "root", turn: { id: "turn-1", status: "completed" } } }, "codex-app-server"), 3_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 3_000))[0].agents[0].state).toMatchObject({ status: "complete", completionScope: "turn" });

    sessions = apply(sessions, normalize("codex-app-server", { method: "turn/started", params: { threadId: "root", turn: { id: "turn-2", status: "inProgress" } } }, "codex-app-server"), 4_000);
    expect(sessions.root).toMatchObject({ runId: "turn-2", state: { status: "thinking" } });

    sessions = apply(sessions, normalize("codex-app-server", { method: "thread/closed", params: { threadId: "root" } }, "codex-app-server"), 5_000);
    expect(sessions.root.state.status).toBe("complete");
  });

  it("keeps failures visible after the normal completion TTL", () => {
    let sessions: Record<string, AgentSession> = {};
    sessions = apply(sessions, normalize("codex-app-server", { method: "turn/started", params: { threadId: "root", turn: { id: "turn-1", status: "inProgress" } } }, "codex-app-server"), 1_000);
    sessions = apply(sessions, normalize("codex-app-server", { method: "turn/completed", params: { threadId: "root", turn: { id: "turn-1", status: "failed", error: { message: "Tests failed" } } } }, "codex-app-server"), 2_000);
    const board = activeBoardWorkstreams(groupWorkstreams(sessions, 120_000));
    expect(board[0]).toMatchObject({ status: "error", attention: true });
    expect(board[0].agents[0].state.detail).toBe("Tests failed");
  });
});
