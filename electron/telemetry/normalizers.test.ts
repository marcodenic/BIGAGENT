import { describe, expect, it } from "vitest";
import { TelemetryHub } from "./hub";
import { normalizeTelemetry, type TelemetryEnvelope } from "./normalizers";

function envelope(format: TelemetryEnvelope["format"], payload: unknown, source = "test") : TelemetryEnvelope {
  return { source, product: "test-agent", transport: format, format, payload, receivedAt: 1_000 };
}

describe("telemetry normalization", () => {
  it("maps compatible lifecycle hooks without retaining prompt contents", () => {
    const [event] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SubagentStart",
      session_id: "session-1",
      prompt: "private prompt text",
    }, "claude-hooks"));
    expect(event.phase).toBe("delegating");
    expect(event.meta?.sessionId).toBe("session-1");
    expect(JSON.stringify(event)).not.toContain("private prompt text");
  });

  it("maps Codex hooks to an authoritative turn lifecycle", () => {
    const [start] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "UserPromptSubmit",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/workspace/project",
    }, "codex-hooks"));
    const [stop] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "Stop",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/workspace/project",
    }, "codex-hooks"));
    expect(start).toMatchObject({ kind: "turn.start", status: "thinking", meta: { sessionId: "thread-1", turnId: "turn-1" } });
    expect(stop).toMatchObject({ kind: "turn.end", status: "idle", meta: { sessionId: "thread-1", turnId: "turn-1" } });
  });

  it("uses Claude MessageDisplay text as public narrative", () => {
    const [event] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "MessageDisplay",
      session_id: "claude-1",
      turn_id: "turn-1",
      message_id: "message-1",
      index: 2,
      final: false,
      delta: "Checking the lifecycle implementation\n",
    }, "claude-hooks"));
    expect(event).toMatchObject({
      kind: "activity",
      phase: "responding",
      detail: "Checking the lifecycle implementation",
      meta: { narrativeKind: "message", messageId: "message-1", messageIndex: 2 },
    });
  });

  it("does not mistake Claude task completion or background work for a finished agent", () => {
    const [task] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "TaskCompleted",
      session_id: "claude-1",
      subject: "Audit lifecycle",
    }, "claude-hooks"));
    const [background] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "Stop",
      session_id: "claude-1",
      turn_id: "turn-1",
      background_tasks: [{ id: "job-1" }],
    }, "claude-hooks"));
    expect(task).toMatchObject({ kind: "activity", status: "working", detail: "Audit lifecycle" });
    expect(background).toMatchObject({ kind: "activity", status: "working", detail: "Background work continues" });
  });

  it("tracks subagents separately and only completes the child that stopped", () => {
    const [start] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SubagentStart",
      session_id: "parent-1",
      turn_id: "turn-1",
      agent_id: "child-1",
      agent_type: "reviewer",
    }, "codex-hooks"));
    const [stop] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SubagentStop",
      session_id: "parent-1",
      turn_id: "turn-1",
      agent_id: "child-1",
      agent_type: "reviewer",
      last_assistant_message: "Review complete",
    }, "codex-hooks"));
    expect(start).toMatchObject({ kind: "session.start", status: "thinking", meta: { sessionId: "child-1", workstreamId: "parent-1", agentName: "reviewer" } });
    expect(stop).toMatchObject({ kind: "session.end", status: "complete", meta: { sessionId: "child-1", workstreamId: "parent-1", lastMessage: "Review complete" } });
  });

  it("keeps session availability, compaction, and session completion distinct", () => {
    const [startup] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SessionStart",
      session_id: "thread-1",
      source: "startup",
    }, "codex-hooks"));
    const [compact] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SessionStart",
      session_id: "thread-1",
      source: "compact",
    }, "codex-hooks"));
    const [ended] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SessionEnd",
      session_id: "thread-1",
      reason: "other",
    }, "codex-hooks"));
    expect(startup).toMatchObject({ kind: "session.start", status: "idle", phase: "idle" });
    expect(compact).toMatchObject({ kind: "activity", status: "thinking", phase: "retrying" });
    expect(ended).toMatchObject({ kind: "session.end", status: "complete" });
    expect(new Set([startup.id, compact.id, ended.id])).toHaveLength(3);
  });

  it("does not deduplicate a continued Stop invocation", () => {
    const [first] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "Stop",
      session_id: "thread-1",
      turn_id: "turn-1",
      stop_hook_active: false,
    }, "codex-hooks"));
    const [continued] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "Stop",
      session_id: "thread-1",
      turn_id: "turn-1",
      stop_hook_active: true,
    }, "codex-hooks"));
    expect(first.id).not.toBe(continued.id);
    expect(continued).toMatchObject({ kind: "activity", status: "working" });
  });

  it("uses Cursor agent thoughts and responses as public narrative", () => {
    const [thought] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "afterAgentThought",
      session_id: "cursor-1",
      text: "Checking the lifecycle state before rendering",
    }, "cursor-hooks"));
    const [response] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "afterAgentResponse",
      session_id: "cursor-1",
      text: "The provider feed is connected",
    }, "cursor-hooks"));

    expect(thought).toMatchObject({
      phase: "planning",
      detail: "Checking the lifecycle state before rendering",
      meta: { activityClass: "narrative", narrativeKind: "reasoning" },
    });
    expect(response).toMatchObject({
      phase: "responding",
      detail: "The provider feed is connected",
      meta: { activityClass: "narrative", narrativeKind: "message" },
    });
  });

  it("uses Gemini AfterAgent output as narrative and a turn boundary", () => {
    const events = normalizeTelemetry(envelope("hook", {
      hook_event_name: "AfterAgent",
      session_id: "gemini-1",
      prompt_id: "prompt-1",
      prompt_response: "Verified the official Gemini hook feed",
    }, "gemini-hooks"));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "activity",
      detail: "Verified the official Gemini hook feed",
      meta: { sessionId: "gemini-1", turnId: "prompt-1", narrativeKind: "message" },
    });
    expect(events[1]).toMatchObject({ kind: "turn.end", status: "idle" });
  });

  it("extracts Windsurf planner narrative without collecting the transcript", () => {
    const events = normalizeTelemetry(envelope("hook", {
      agent_action_name: "post_cascade_response",
      trajectory_id: "cascade-1",
      execution_id: "execution-1",
      tool_info: {
        response: "### Planner Response\nInspecting the provider lifecycle\n\n### Other\nprivate tool details",
      },
    }, "windsurf-hooks"));

    expect(events[0]).toMatchObject({
      detail: "Inspecting the provider lifecycle",
      meta: { sessionId: "cascade-1", turnId: "execution-1", narrativeKind: "message" },
    });
    expect(events[1]).toMatchObject({ kind: "turn.end", status: "idle" });
    expect(JSON.stringify(events)).not.toContain("private tool details");
  });

  it("waits for Grok's idle notification when a stop hook may continue", () => {
    const [continued] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "Stop",
      session_id: "grok-1",
      stop_hook_active: true,
    }, "grok-hooks"));
    const [idle] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "Notification",
      session_id: "grok-1",
      notification_type: "idle_prompt",
    }, "grok-hooks"));

    expect(continued).toMatchObject({ kind: "activity", status: "working" });
    expect(idle).toMatchObject({ kind: "turn.end", status: "idle" });
  });

  it("preserves the command nested in Codex tool input", () => {
    const [start] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "PreToolUse",
      session_id: "thread-1",
      turn_id: "turn-1",
      tool_use_id: "call-1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test -- --runInBand" },
    }, "codex-hooks"));
    const [end] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "PostToolUse",
      session_id: "thread-1",
      turn_id: "turn-1",
      tool_use_id: "call-1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test -- --runInBand" },
    }, "codex-hooks"));
    expect(start).toMatchObject({ kind: "command.start", command: "pnpm test -- --runInBand", detail: "pnpm test -- --runInBand" });
    expect(end).toMatchObject({ kind: "command.end", command: "pnpm test -- --runInBand", detail: "pnpm test -- --runInBand" });
  });

  it("maps OTLP GenAI log attributes into a tool activity", () => {
    const [event] = normalizeTelemetry(envelope("otlp-logs", {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1000000000",
          body: { stringValue: "tool.execute" },
          attributes: [
            { key: "session.id", value: { stringValue: "session-2" } },
            { key: "gen_ai.tool.name", value: { stringValue: "Edit" } },
          ],
        }] }],
      }],
    }, "collector-otlp"));
    expect(event.status).toBe("editing");
    expect(event.phase).toBe("editing");
    expect(event.meta?.product).toBe("claude-code");
  });

  it("maps ACP session updates and OpenCode SSE events", () => {
    const [acp] = normalizeTelemetry(envelope("acp", {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk" } },
    }, "acp"));
    const [opencode] = normalizeTelemetry(envelope("opencode", {
      type: "permission.asked",
      properties: { sessionID: "open-1" },
    }, "opencode-sse"));
    expect(acp.phase).toBe("responding");
    expect(opencode.status).toBe("approval");
  });

  it("uses OpenCode output parts as narrative and preserves child session ownership", () => {
    const [child] = normalizeTelemetry(envelope("opencode", {
      type: "session.created",
      cwd: "/workspace/project",
      properties: { info: { id: "open-child", parentID: "open-parent", directory: "/workspace/project", title: "Audit the provider lifecycle" } },
    }, "opencode"));
    const [narrative] = normalizeTelemetry(envelope("opencode", {
      type: "message.part.updated",
      cwd: "/workspace/project",
      properties: {
        sessionID: "open-child",
        part: { id: "part-1", sessionID: "open-child", type: "text", text: "Verifying the OpenCode provider" },
      },
    }, "opencode"));

    expect(child.meta).toMatchObject({
      sessionId: "open-child",
      parentSessionId: "open-parent",
      workstreamId: "open-parent",
      workstreamName: "project",
      sessionTitle: "Audit the provider lifecycle",
    });
    expect(narrative).toMatchObject({
      detail: "Verifying the OpenCode provider",
      meta: { sessionId: "open-child", activityClass: "narrative", narrativeKind: "message" },
    });
  });

  it("preserves public plan steps from Codex app-server updates", () => {
    const [event] = normalizeTelemetry(envelope("codex-app-server", {
      method: "item.plan_updated",
      params: { threadId: "thread-1", item: { type: "plan", steps: [{ content: "Inspect the source" }, { title: "Render the plan" }] } },
    }, "codex-app-server"));
    expect(event.kind).toBe("plan");
    expect(event.plan).toEqual(["Inspect the source", "Render the plan"]);
  });

  it("does not promote streamed Codex text fragments into headline events", () => {
    const reasoning = normalizeTelemetry(envelope("codex-app-server", {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "Verifying the provider feed" },
    }, "codex-app-server"));
    const message = normalizeTelemetry(envelope("codex-app-server", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "Fixed" },
    }, "codex-app-server"));
    const output = normalizeTelemetry(envelope("codex-app-server", {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", delta: "test output" },
    }, "codex-app-server"));

    expect(reasoning).toEqual([]);
    expect(message).toEqual([]);
    expect(output).toEqual([]);
  });

  it("uses finalized Codex reasoning summaries as stable headline narrative", () => {
    const [event] = normalizeTelemetry(envelope("codex-app-server", {
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: {
        id: "reason-1",
        type: "reasoning",
        summary: ["**Verifying the provider feed**", "**Verifying the provider feed**", "**Checking lifecycle state**"],
      } },
    }, "codex-app-server"));
    expect(event).toMatchObject({
      kind: "reasoning.summary",
      detail: "**Verifying the provider feed** **Checking lifecycle state**",
      meta: { narrativeKind: "reasoning" },
    });
  });

  it("does not replace useful narrative with empty Codex item-start placeholders", () => {
    const reasoning = normalizeTelemetry(envelope("codex-app-server", {
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "reason-1", type: "reasoning", summary: [] } },
    }, "codex-app-server"));
    const message = normalizeTelemetry(envelope("codex-app-server", {
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage" } },
    }, "codex-app-server"));

    expect(reasoning).toEqual([]);
    expect(message).toEqual([]);
  });

  it("uses the Codex workspace directory rather than the task title for the workstream", () => {
    const [event] = normalizeTelemetry(envelope("codex-app-server", {
      method: "thread/started",
      params: { thread: { id: "thread-1", name: "Fix stale completed sessions", cwd: "/workspace/BIGAGENT" } },
    }, "codex-app-server"));

    expect(event.meta).toMatchObject({
      workstreamName: "BIGAGENT",
      project: "BIGAGENT",
      sessionTitle: "Fix stale completed sessions",
    });
  });

  it("maps Codex app-server thread and turn boundaries without conflating them", () => {
    const [threadStarted] = normalizeTelemetry(envelope("codex-app-server", {
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    }, "codex-app-server"));
    const [turnStarted] = normalizeTelemetry(envelope("codex-app-server", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
    }, "codex-app-server"));
    const [turnCompleted] = normalizeTelemetry(envelope("codex-app-server", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    }, "codex-app-server"));
    const [threadClosed] = normalizeTelemetry(envelope("codex-app-server", {
      method: "thread/closed",
      params: { threadId: "thread-1" },
    }, "codex-app-server"));
    expect(threadStarted).toMatchObject({ kind: "session.start", status: "idle" });
    expect(turnStarted).toMatchObject({ kind: "turn.start", status: "thinking", meta: { turnId: "turn-1" } });
    expect(turnCompleted).toMatchObject({ kind: "turn.end", status: "idle", meta: { turnId: "turn-1" } });
    expect(threadClosed).toMatchObject({ kind: "session.end", status: "complete" });
    expect(new Set([threadStarted.id, turnStarted.id, turnCompleted.id, threadClosed.id])).toHaveLength(4);
  });

  it("uses app-server session trees to group subagents under their root", () => {
    const [event] = normalizeTelemetry(envelope("codex-app-server", {
      method: "thread/started",
      params: { thread: {
        id: "child-1",
        sessionId: "root-1",
        parentThreadId: "root-1",
        cwd: "/workspace/project",
        agentNickname: "reviewer",
        modelProvider: "openai",
      } },
    }, "codex-app-server"));
    expect(event.meta).toMatchObject({
      sessionId: "child-1",
      threadId: "child-1",
      parentSessionId: "root-1",
      workstreamId: "root-1",
      workstreamName: "project",
      agentName: "reviewer",
      modelProvider: "openai",
    });
  });

  it("keeps repeated app-server turns and plan revisions uniquely identifiable", () => {
    const events = ["turn-1", "turn-2"].map((turnId) => normalizeTelemetry(envelope("codex-app-server", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } },
    }, "codex-app-server"))[0]);
    const plans = ["Inspect", "Verify"].map((step) => normalizeTelemetry(envelope("codex-app-server", {
      method: "turn/plan/updated",
      params: { threadId: "thread-1", turnId: "turn-2", plan: [{ step }] },
    }, "codex-app-server"))[0]);
    expect(events[0].id).not.toBe(events[1].id);
    expect(plans[0].id).not.toBe(plans[1].id);
  });

  it("treats a one-shot Codex JSON turn completion as process completion", () => {
    const [event] = normalizeTelemetry(envelope("codex-json", {
      type: "turn.completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
    }, "codex-json"));
    expect(event).toMatchObject({ kind: "session.end", status: "complete" });
  });

  it("deduplicates retransmitted events and reports source health", () => {
    const hub = new TelemetryHub();
    const input = envelope("protocol", {
      version: 1,
      id: "same-event",
      timestamp: "2026-08-25T12:00:00Z",
      kind: "activity",
      status: "thinking",
    }, "protocol");
    expect(hub.ingest(input)).toHaveLength(1);
    expect(hub.ingest(input)).toHaveLength(0);
    expect(hub.health()[0]).toMatchObject({ id: "protocol", state: "live", eventCount: 1 });
  });
});
