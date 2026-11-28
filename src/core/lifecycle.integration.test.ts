import { currentMessage } from "./currentMessage";
import { TelemetryHub } from "../../electron/telemetry/hub";
import { claudeRegistryEvent } from "../../electron/providers/claude";
import { elapsedMs } from "./reducer";
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
  it("assembles Claude display batches and retains them across empty final batches and tool traffic", () => {
    const hub = new TelemetryHub();
    let sessions: Record<string, AgentSession> = {};
    let time = 1000;
    hub.onEvent(event => { sessions = applySessionEvent(sessions, event, time, "claude-hooks"); });
    const send = (fields: Record<string, unknown>) => hub.ingest({
      source: "claude-hooks", product: "claude", transport: "http", format: "hook", receivedAt: ++time,
      payload: { session_id: "claude", prompt_id: "prompt", ...fields },
    });
    send({ hook_event_name: "UserPromptSubmit" });
    const batch = (index: number, delta: string, final = false, message_id = "message") => send({
      hook_event_name: "MessageDisplay", turn_id: "display-turn", message_id, index, delta, final,
    });
    batch(0, "Checking capacity limits.\n");
    batch(2, ""); // An empty final callback may arrive before another batch.
    batch(1, "The server is still listening.\n");
    batch(1, "The server is still listening.\n");
    batch(3, "", true);
    for (let i = 0; i < 90; i++) send({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `tool-${i}` });
    expect(currentMessage(sessions.claude, false)).toBe("Checking capacity limits. The server is still listening.");
    // Non-interactive Claude sends the whole message in one final batch.
    batch(0, "The audit is complete.", true, "next-message");
    expect(currentMessage(sessions.claude, false)).toBe("The audit is complete.");
    send({ hook_event_name: "UserPromptSubmit", prompt_id: "next-prompt" });
    expect(sessions.claude.messageStream).toBeUndefined();
    expect(currentMessage(sessions.claude, false)).toBe("");
  });

  it("keeps Claude messages and the timer when message hooks include a distinct turn ID", () => {
    const hook = (name: string, fields: Record<string, unknown> = {}, time = 1000) => normalizeTelemetry({
      source: "claude-hooks", product: "claude", transport: "http", format: "hook", receivedAt: time,
      payload: { hook_event_name: name, session_id: "claude", prompt_id: "prompt-1", ...fields },
    })[0];
    let sessions = applySessionEvent({}, hook("UserPromptSubmit"), 1000, "claude-hooks");
    const message = hook("MessageDisplay", { turn_id: "display-turn", message_id: "message-1", index: 0, delta: "Checking capacity limits.\n" }, 2000);
    sessions = applySessionEvent(sessions, message, 2000, "claude-hooks");
    expect(currentMessage(sessions.claude, false)).toBe("Checking capacity limits.");
    sessions = applySessionEvent(sessions, hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-1" }, 3000), 3000, "claude-hooks");
    expect(currentMessage(sessions.claude, false)).toBe("Checking capacity limits.");
    expect(sessions.claude.state.startedAt).toBe(1000);
    expect(sessions.claude.runId).toBe("prompt-1");
    sessions = applySessionEvent(sessions, hook("UserPromptSubmit", { prompt_id: "prompt-2" }, 4000), 4000, "claude-hooks");
    expect(currentMessage(sessions.claude, false)).toBe("");
    expect(sessions.claude.state.startedAt).toBe(4000);
  });

  it.each([undefined, "idle"])("keeps a live hook message when the registry catches up from %s", previousState => {
    let now = Date.now();
    const hook = (payload: Record<string, unknown>) => normalizeTelemetry({
      source: "claude-hooks", product: "claude", transport: "http", format: "hook", receivedAt: now++,
      payload: { session_id: "claude-1", ...payload },
    })[0];
    const start = hook({ hook_event_name: "UserPromptSubmit" });
    let sessions = applySessionEvent({}, start, now, "claude-hooks");
    const message = hook({ hook_event_name: "MessageDisplay", message_id: "message-1", index: 0, delta: "Checking the capacity limits." });
    sessions = applySessionEvent(sessions, message, now, "claude-hooks");
    const runId = sessions["claude-1"].runId;
    const startedAt = sessions["claude-1"].state.startedAt;
    const registry = claudeRegistryEvent({ sessionId: "claude-1", state: "working" }, previousState)!;
    registry.timestamp = new Date(now++).toISOString();
    sessions = applySessionEvent(sessions, registry, now, "claude-agents");
    sessions = applySessionEvent(sessions, hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "tool-1" }), now, "claude-hooks");
    expect(currentMessage(sessions["claude-1"], false)).toBe("Checking the capacity limits.");
    expect(sessions["claude-1"].runId).toBe(runId);
    expect(sessions["claude-1"].state.startedAt).toBe(startedAt);
    sessions = applySessionEvent(sessions, hook({ hook_event_name: "UserPromptSubmit" }), now, "claude-hooks");
    expect(currentMessage(sessions["claude-1"], false)).toBe("");
  });

  it("still starts and resumes sessions observed only through the registry", () => {
    let sessions = applySessionEvent({}, claudeRegistryEvent({ sessionId: "registry", state: "working" })!, Date.now(), "claude-agents");
    const firstRun = sessions.registry.runId;
    sessions = applySessionEvent(sessions, claudeRegistryEvent({ sessionId: "registry", state: "done", summary: "Finished." }, "working")!, Date.now(), "claude-agents");
    expect(currentMessage(sessions.registry, false)).toBe("Finished.");
    sessions = applySessionEvent(sessions, claudeRegistryEvent({ sessionId: "registry", state: "working" }, "done")!, Date.now(), "claude-agents");
    expect(sessions.registry.runId).not.toBe(firstRun);
    expect(sessions.registry.state.status).toBe("thinking");
    expect(currentMessage(sessions.registry, false)).toBe("");
  });

  it.each(["state", "status"])("keeps an initially idle registry session off the board (%s)", (field) => {
    const event = claudeRegistryEvent({ sessionId: "session-1", [field]: "idle", startedAt: 1 })!;
    expect(event).toMatchObject({ status: "idle", kind: "turn.end", phase: "idle", label: "READY" });
    const sessions = applySessionEvent({}, event, 100_000, "claude-agents");
    expect(groupWorkstreams(sessions, 100_000)).toEqual([]);
    expect(elapsedMs(sessions["session-1"].state, 200_000)).toBe(0);
  });

  it("ends observed work on idle and starts a fresh timer when work resumes", () => {
    let sessions: Record<string, AgentSession> = {};
    let previous: string | undefined;
    const observe = (state: string, now: number) => {
      const event = claudeRegistryEvent({ sessionId: "session-1", state, startedAt: 1 }, previous)!;
      sessions = applySessionEvent(sessions, event, now, "claude-agents");
      previous = state;
    };
    observe("working", 1_000);
    observe("idle", 2_000);
    expect(sessions["session-1"].state).toMatchObject({ status: "complete", completionScope: "turn", endedAt: 2_000 });
    expect(groupWorkstreams(sessions, 22_001)).toEqual([]);
    observe("working", 30_000);
    expect(sessions["session-1"].state).toMatchObject({ status: "thinking", startedAt: 30_000, endedAt: null });
    expect(elapsedMs(sessions["session-1"].state, 31_000)).toBe(1_000);
  });


  it("leaves RUNNING TESTS on command completion and accepts reasoning without text", () => {
    let sessions: Record<string, AgentSession> = {};
    const item = (method: string, item: Record<string, unknown>) => normalize("codex-app-server", {
      method, params: { threadId: "root", turnId: "turn", item },
    }, "codex-app-server");
    sessions = apply(sessions, item("item/started", { id: "cmd", type: "commandExecution", command: "pnpm test" }), 1_000);
    expect(sessions.root.state.label).toBe("RUNNING TESTS");
    sessions = apply(sessions, item("item/completed", { id: "cmd", type: "commandExecution", command: "pnpm test", status: "completed" }), 2_000);
    expect(sessions.root.state.status).toBe("working");
    sessions = apply(sessions, item("item/started", { id: "reason", type: "reasoning", summary: [] }), 3_000);
    expect(sessions.root.state).toMatchObject({ status: "thinking", label: "THINKING" });
    sessions = apply(sessions, item("item/started", { id: "read", type: "commandExecution", command: "cat tests/test.test.ts" }), 4_000);
    expect(sessions.root.state).toMatchObject({ status: "command", label: "RUNNING" });
  });

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

  it("keeps Claude task-list activity on the parent and child hooks on the child", () => {
    const claude = (payload: Record<string, unknown>) => normalizeTelemetry({
      source: "claude-hooks", product: "claude", transport: "lifecycle-hooks", format: "hook", payload, receivedAt: 1_000,
    })[0];
    let sessions: Record<string, AgentSession> = {};
    sessions = apply(sessions, claude({ hook_event_name: "UserPromptSubmit", session_id: "root", prompt_id: "prompt" }), 1_000);
    sessions = apply(sessions, claude({ hook_event_name: "TaskCreated", session_id: "root", task_id: "1", task_subject: "Inspect provider" }), 2_000);
    expect(sessions.root.state).toMatchObject({ phase: "planning", detail: "Inspect provider" });
    expect(groupWorkstreams(sessions, 2_000)[0].agents).toHaveLength(1);
    sessions = apply(sessions, claude({ hook_event_name: "SubagentStart", session_id: "root", agent_id: "child", agent_type: "Explore" }), 3_000);
    sessions = apply(sessions, claude({ hook_event_name: "PreToolUse", session_id: "root", agent_id: "child", agent_type: "Explore", tool_name: "Edit" }), 4_000);
    expect(sessions.child).toMatchObject({ parentSessionId: "root", state: { status: "editing" } });
    expect(sessions.root.state.detail).toBe("Inspect provider");
    expect(groupWorkstreams(sessions, 4_000)[0].agents.map((agent) => agent.id)).toEqual(["root", "child"]);
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
