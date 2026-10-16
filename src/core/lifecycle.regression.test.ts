import { describe, expect, it } from "vitest";
import { normalizeSimpleEvent, type AgentEvent } from "./protocol";
import { applySessionEvent, groupWorkstreams, activeBoardWorkstreams, replaceSessionSnapshot, replaceSessionSource } from "./workstreams";
import { claudeRegistryEvent } from "../../electron/providers/claude";
import { TelemetryHub } from "../../electron/telemetry/hub";

const event = (id: string, status: "thinking" | "complete" | "stopped", time: number, meta = {}) => ({
  ...normalizeSimpleEvent({ status, meta: { sessionId: "agent", turnId: "turn", ...meta } }, id),
  timestamp: new Date(time).toISOString(),
});

describe("agent lifecycle regressions", () => {
  it("replays a large completed history using original times without flooding the board", () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 40; i++) {
      events.push({ ...event(`start-${i}`, "thinking", 1_000, { sessionId: `agent-${i}` }), kind: "turn.start" });
      events.push({ ...event(`done-${i}`, "complete", 5_000, { sessionId: `agent-${i}` }), kind: "turn.end" });
    }
    events.push(event("live", "thinking", 59_000, { sessionId: "live" }));
    const sessions = replaceSessionSource({}, "claude-hooks", events, 60_000);
    expect(groupWorkstreams(sessions, 60_000).map(row => row.id)).toEqual(["live"]);
    expect(sessions["agent-0"].state).toMatchObject({ startedAt: 1_000, endedAt: 5_000 });
  });

  it("does not refresh DONE on repeated terminal notifications", () => {
    let sessions = applySessionEvent({}, event("start", "thinking", 1_000), 1_000);
    for (const time of [2_000, 10_000, 30_000]) {
      sessions = applySessionEvent(sessions, { ...event(`end-${time}`, "complete", time), kind: "turn.end" }, time);
    }
    expect(sessions.agent.state.endedAt).toBe(2_000);
    expect(groupWorkstreams(sessions, 30_000)).toEqual([]);
  });

  it("accepts persisted Codex stop evidence after a lost server notification", () => {
    let sessions = applySessionEvent({}, event("live", "thinking", 1_000), 1_000, "codex-app-server");
    const stopped = event("stopped", "stopped", 3_000, { completedAtMs: 3_000 });
    sessions = replaceSessionSource(sessions, "codex-desktop-fallback", [stopped], 4_000);
    expect(sessions.agent.state.status).toBe("stopped");
    sessions = applySessionEvent(sessions, event("late-item", "thinking", 4_000), 4_000, "codex-app-server");
    expect(sessions.agent.state.status).toBe("stopped");
    sessions = applySessionEvent(sessions, event("next", "thinking", 5_000, { turnId: "next-turn" }), 5_000, "codex-app-server");
    expect(sessions.agent.state.status).toBe("thinking");
  });

  it("does not let an old fallback turn replace a newer server turn", () => {
    let sessions = applySessionEvent({}, event("next", "thinking", 30_000, { turnId: "next-turn" }), 30_000, "codex-app-server");
    sessions = replaceSessionSource(sessions, "codex-desktop-fallback", [event("old", "stopped", 3_000, { startedAtMs: 1_000, completedAtMs: 3_000 })], 31_000);
    expect(sessions.agent.runId).toBe("next-turn");
  });

  it("lets Claude registry reconciliation end hook-observed work and preserves child grouping", () => {
    let sessions = applySessionEvent({}, event("start", "thinking", 1_000, { parentSessionId: "root", workstreamId: "root" }), 1_000, "claude-hooks");
    const stopped = claudeRegistryEvent({ sessionId: "agent", parentSessionId: "root", state: "stopped" }, "working")!;
    sessions = applySessionEvent(sessions, stopped, 2_000, "claude-agents");
    expect(sessions.agent).toMatchObject({ parentSessionId: "root", workstreamId: "root", state: { status: "stopped", completionScope: "none" } });
    expect(groupWorkstreams(sessions, 22_001)).toEqual([]);
  });

  it("keeps live work ahead of many recent completion receipts", () => {
    let sessions = {};
    for (let i = 0; i < 30; i++) sessions = applySessionEvent(sessions, event(`done-${i}`, "complete", 1_000, { sessionId: `done-${i}` }), 1_000);
    sessions = applySessionEvent(sessions, event("live", "thinking", 2_000, { sessionId: "live" }), 2_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 3_000))[0].id).toBe("live");
  });

  it("retains source clocks and child identity through reconnect snapshots", () => {
    const start = { ...event("start", "thinking", 1_000), kind: "turn.start" as const, meta: { sessionId: "agent", source: "claude-hooks" } };
    const done = { ...event("done", "complete", 2_000), kind: "turn.end" as const, meta: start.meta };
    const sessions = replaceSessionSnapshot({}, [start, done], ["claude-hooks"], 60_000);
    expect(groupWorkstreams(sessions, 60_000)).toEqual([]);
  });

  it("delivers repeated Claude prompts without IDs and ends a final continued Stop", () => {
    const hub = new TelemetryHub();
    let sessions = {};
    hub.onEvent(event => { sessions = applySessionEvent(sessions, event, Date.parse(event.timestamp), "claude-hooks"); });
    const hook = (hook_event_name: string, receivedAt: number, extra = {}) => hub.ingest({ source: "claude-hooks", product: "claude", transport: "http", format: "hook", receivedAt, payload: { session_id: "root", hook_event_name, ...extra } });
    hook("UserPromptSubmit", 1_000);
    hook("Stop", 2_000, { stop_hook_active: true });
    expect(groupWorkstreams(sessions, 2_000)[0].status).toBe("complete");
    expect(hook("UserPromptSubmit", 3_000)).toHaveLength(1);
    expect(groupWorkstreams(sessions, 3_000)[0].status).toBe("thinking");
    hook("Stop", 4_000);
    expect(groupWorkstreams(sessions, 24_001)).toEqual([]);
  });
});

it("tracks current Codex collaboration payloads through spawn, wait, and interruption", () => {
  const hub = new TelemetryHub();
  let sessions = {};
  let time = 1_000;
  hub.onEvent(event => { sessions = applySessionEvent(sessions, event, time, "codex-app-server"); });
  const item = (tool: string, status: string) => {
    time += 1_000;
    hub.ingest({ source: "codex-app-server", product: "codex", transport: "rpc", format: "codex-app-server", receivedAt: time,
      payload: { method: "item/completed", params: { threadId: "root", turnId: "parent-turn", item: { id: `${tool}-${time}`, type: "collabAgentToolCall", tool, status: "completed", senderThreadId: "root", receiverThreadIds: ["child"], agentsStates: { child: { status, message: null } } } } } });
  };
  item("spawnAgent", "running");
  const spawned = groupWorkstreams(sessions, time);
  expect(spawned).toHaveLength(1);
  expect(spawned[0].agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "root" }), expect.objectContaining({ id: "child", parentSessionId: "root", state: expect.objectContaining({ status: "thinking" }) })]));
  item("wait", "completed");
  expect(groupWorkstreams(sessions, time)[0].agents.find(agent => agent.id === "child")?.state.status).toBe("complete");
  item("wait", "running");
  expect(groupWorkstreams(sessions, time)[0].agents.find(agent => agent.id === "child")?.state.status).toBe("complete");
  item("resumeAgent", "running");
  expect(groupWorkstreams(sessions, time)[0].agents.find(agent => agent.id === "child")?.state).toMatchObject({ status: "thinking", startedAt: time });
  item("closeAgent", "shutdown");
  expect(groupWorkstreams(sessions, time)[0].agents.find(agent => agent.id === "child")?.state.status).toBe("stopped");
  expect(groupWorkstreams(sessions, time + 20_001)[0].agents.map(agent => agent.id)).toEqual(["root"]);
});

it.each([false, true])("replays mixed transports chronologically regardless of source order (%s)", reverse => {
  const live = [
    { ...event("session", "thinking", 1_000), kind: "session.start" as const, meta: { sessionId: "agent", source: "codex-app-server" } },
    { ...event("turn", "thinking", 2_000), kind: "turn.start" as const, meta: { sessionId: "agent", source: "codex-app-server", turnId: "turn" } },
  ];
  const stopped = { ...event("persisted-stop", "stopped", 3_000), meta: { sessionId: "agent", source: "codex-desktop-fallback", turnId: "turn", startedAtMs: 2_000, completedAtMs: 3_000 } };
  const sessions = replaceSessionSnapshot({}, reverse ? [...live, stopped] : [stopped, ...live], [], 60_000);
  expect(sessions.agent.state.status).toBe("stopped");
  expect(groupWorkstreams(sessions, 60_000)).toEqual([]);
});

it("keeps a Claude child's name and role on sparse tool and stop hooks", () => {
  const hub = new TelemetryHub();
  let sessions = {};
  hub.onEvent(event => { sessions = applySessionEvent(sessions, event, 1_000, "claude-hooks"); });
  for (const payload of [
    { hook_event_name: "SubagentStart", agent_type: "Explore" },
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "read-1" },
    { hook_event_name: "SubagentStop" },
  ]) hub.ingest({ source: "claude-hooks", product: "claude", transport: "http", format: "hook", receivedAt: 1_000, payload: { session_id: "root", agent_id: "child", ...payload } });
  expect(groupWorkstreams(sessions, 1_000)[0].agents[0]).toMatchObject({ id: "child", agentName: "Explore", agentRole: "Explore", parentSessionId: "root" });
});

it("does not replace a child's real turn with a late spawn result", () => {
  const hub = new TelemetryHub();
  let sessions = {};
  hub.onEvent(event => { sessions = applySessionEvent(sessions, event, Date.parse(event.timestamp), "codex-app-server"); });
  const observe = (receivedAt: number, method: string, params: object) => hub.ingest({ source: "codex-app-server", product: "codex", transport: "rpc", format: "codex-app-server", receivedAt, payload: { method, params } });
  observe(1_000, "turn/started", { threadId: "child", turn: { id: "child-turn", status: "inProgress" } });
  observe(2_000, "item/completed", { threadId: "root", turnId: "parent-turn", item: { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", senderThreadId: "root", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } } });
  const child = groupWorkstreams(sessions, 2_000)[0].agents.find(agent => agent.id === "child");
  expect(child).toMatchObject({ runId: "child-turn", parentSessionId: "root", state: { startedAt: 1_000 } });
});
