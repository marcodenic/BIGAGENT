import { describe, expect, it } from "vitest";
import { normalizeSimpleEvent } from "./protocol";
import { activeBoardWorkstreams, applySessionEvent, groupWorkstreams, projectWorkstreamPresentation, replaceSessionSnapshot, replaceSessionSource } from "./workstreams";

function event(sessionId: string, threadId: string, status: "thinking" | "testing" | "waiting" | "complete", detail: string) {
  return normalizeSimpleEvent({ status, detail, meta: { sessionId, threadId, workstreamName: "PROPER LINUX", agentName: `Agent ${sessionId}` } }, sessionId);
}

describe("workstream projection", () => {
  it("shows completed roots in other workstreams while work continues", () => {
    let sessions = applySessionEvent({}, event("live", "one", "thinking", "Working"), 1_000);
    sessions = applySessionEvent(sessions, event("done", "two", "complete", "Finished"), 2_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 2_000))).toHaveLength(2);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 22_001))).toHaveLength(1);
  });

  it("does not restart the completion countdown on snapshot replay", () => {
    const done = event("done", "project", "complete", "Finished");
    let sessions = replaceSessionSource({}, "codex", [done], 1_000);
    sessions = replaceSessionSource(sessions, "codex", [done], 15_000);
    expect(groupWorkstreams(sessions, 21_001)).toHaveLength(0);
  });

  it.each(["error", "turn", "child"])("keeps completed roots beside a %s row when no work is running", (kind) => {
    let sessions = applySessionEvent({}, event("done", "one", "complete", "Finished"), 1_000);
    const other = normalizeSimpleEvent({ status: kind === "error" ? "error" : "complete",
      meta: { sessionId: "other", threadId: "two", ...(kind === "child" ? { parentSessionId: "parent" } : {}) } }, "other");
    if (kind === "turn") other.kind = "turn.end";
    sessions = applySessionEvent(sessions, other, 2_000);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 2_000))).toHaveLength(2);
    expect(activeBoardWorkstreams(groupWorkstreams(sessions, 22_001))).toHaveLength(kind === "error" ? 1 : 0);
  });

  it("groups several sessions into one stable workstream", () => {
    let sessions = applySessionEvent({}, event("01", "project", "thinking", "Planning"), 1_000, "codex");
    sessions = applySessionEvent(sessions, event("02", "project", "testing", "Running tests"), 2_000, "codex");
    const workstreams = groupWorkstreams(sessions, 2_000);
    expect(workstreams).toHaveLength(1);
    expect(workstreams[0].agents).toHaveLength(2);
    expect(workstreams[0].label).toBe("WORKING");
  });

  it("retains a native session title separately from the project name", () => {
    const titled = normalizeSimpleEvent({
      status: "thinking",
      detail: "Planning",
      meta: { sessionId: "01", threadId: "project", workstreamName: "BIGAGENT", sessionTitle: "Fix stale completed sessions" },
    }, "titled");
    const sessions = applySessionEvent({}, titled, 1_000, "codex-app-server");

    expect(sessions["01"]).toMatchObject({
      workstreamName: "BIGAGENT",
      sessionTitle: "Fix stale completed sessions",
    });
  });

  it("keeps tool results in activity without promoting them to the headline", () => {
    const result = normalizeSimpleEvent({
      status: "working",
      phase: "receiving",
      label: "RESULT RECEIVED",
      detail: "exec command finished",
      meta: { sessionId: "01", threadId: "project", workstreamName: "PROPER LINUX" },
    }, "tool-result");
    const sessions = applySessionEvent({}, result, 1_000, "codex");
    const [workstream] = groupWorkstreams(sessions, 1_000);
    expect(workstream.label).toBe("WORKING");
    expect(workstream.phase).toBe("receiving");
    expect(workstream.agents[0].state.recent[0]).toMatchObject({ label: "RESULT RECEIVED", detail: "exec command finished" });
  });

  it("marks attention without making stable workstream rows jump", () => {
    let sessions = applySessionEvent({}, event("01", "alpha", "testing", "Tests"), 1_000, "codex");
    sessions = applySessionEvent(sessions, event("02", "beta", "waiting", "Permission required"), 2_000, "codex");
    const workstreams = groupWorkstreams(sessions, 2_000);
    expect(workstreams.map((workstream) => workstream.id)).toEqual(["alpha", "beta"]);
    expect(workstreams[1].attention).toBe(true);
  });

  it("does not let a stopped sibling override a live agent", () => {
    const stopped = normalizeSimpleEvent({ status: "error", label: "STOPPED", detail: "Interrupted", meta: { sessionId: "old", threadId: "project", workstreamName: "PROPER LINUX" } }, "stopped");
    const running = normalizeSimpleEvent({ status: "thinking", detail: "Continuing work", meta: { sessionId: "live", threadId: "project", workstreamName: "PROPER LINUX" } }, "running");
    let sessions = applySessionEvent({}, stopped, 1_000, "codex");
    sessions = applySessionEvent(sessions, running, 2_000, "codex");
    const [workstream] = groupWorkstreams(sessions, 2_000, Number.POSITIVE_INFINITY);
    expect(workstream.status).toBe("thinking");
    expect(workstream.attention).toBe(false);
  });

  it("keeps a root error visible and actionable until the session resumes", () => {
    const failed = normalizeSimpleEvent({ status: "error", detail: "Agent crashed", meta: { sessionId: "root", threadId: "project" } }, "failed");
    const sessions = applySessionEvent({}, failed, 1_000, "codex-hooks");
    const workstreams = groupWorkstreams(sessions, 120_000);
    const board = activeBoardWorkstreams(workstreams);
    expect(workstreams[0]).toMatchObject({ status: "error", attention: true });
    expect(board[0].agents[0]).toMatchObject({ id: "root", state: { status: "error" } });
  });

  it("keeps a recently completed sibling on a live workstream board", () => {
    const done = normalizeSimpleEvent({
      status: "complete",
      detail: "Review finished",
      meta: { sessionId: "child", threadId: "project", parentSessionId: "parent", workstreamName: "PROPER LINUX" },
    }, "child-done");
    const running = event("parent", "project", "thinking", "Integrating review");
    let sessions = applySessionEvent({}, done, 1_000, "codex-hooks");
    sessions = applySessionEvent(sessions, running, 2_000, "codex-hooks");
    const board = activeBoardWorkstreams(groupWorkstreams(sessions, 2_000));
    expect(board).toHaveLength(1);
    expect(board[0].agents.map((agent) => [agent.id, agent.state.status])).toEqual([
      ["child", "complete"],
      ["parent", "thinking"],
    ]);
  });

  it("keeps a completed child visible when its parent becomes turn-idle", () => {
    const done = normalizeSimpleEvent({
      status: "complete",
      detail: "Review finished",
      meta: { sessionId: "child", threadId: "project", parentSessionId: "parent", workstreamName: "PROPER LINUX" },
    }, "child-done");
    const idle = normalizeSimpleEvent({ status: "idle", detail: "Turn finished", meta: { sessionId: "parent", threadId: "project" } }, "parent-idle");
    let sessions = applySessionEvent({}, done, 1_000, "codex-hooks");
    sessions = applySessionEvent(sessions, idle, 2_000, "codex-hooks");
    const board = activeBoardWorkstreams(groupWorkstreams(sessions, 2_000));
    expect(board).toHaveLength(1);
    expect(board[0].agents.map((agent) => [agent.id, agent.state.status])).toEqual([["child", "complete"]]);
  });

  it("does not present turn-idle as completed work", () => {
    const idle = normalizeSimpleEvent({ status: "idle", detail: "Turn finished", meta: { sessionId: "parent", threadId: "project" } }, "idle");
    const sessions = applySessionEvent({}, idle, 1_000, "codex-hooks");
    expect(groupWorkstreams(sessions, 1_000)).toEqual([]);
  });

  it("keeps a completed root turn on the board without claiming the session ended", () => {
    const started = { ...normalizeSimpleEvent({ status: "thinking", meta: { sessionId: "root", threadId: "project" } }, "turn-start"), kind: "turn.start" as const };
    const stopped = { ...normalizeSimpleEvent({ status: "idle", detail: "Turn finished", meta: { sessionId: "root", threadId: "project" } }, "turn-stop"), kind: "turn.end" as const };
    let sessions = applySessionEvent({}, started, 1_000, "codex-hooks");
    sessions = applySessionEvent(sessions, stopped, 2_000, "codex-hooks");
    const presentation = projectWorkstreamPresentation(groupWorkstreams(sessions, 2_000), 2_000);
    expect(presentation.boardWorkstreams[0].agents[0].state).toMatchObject({ status: "complete", completionScope: "turn" });
    expect(presentation.completedRootAgents).toEqual([]);
    expect(presentation.recentlyDone).toBe(1);
  });

  it("reconciles snapshots and ages completed work out", () => {
    const running = event("01", "project", "thinking", "Planning");
    const done = event("02", "done", "complete", "Finished");
    let sessions = replaceSessionSource({}, "codex", [running, done], 1_000);
    expect(groupWorkstreams(sessions, 1_000)).toHaveLength(2);
    sessions = replaceSessionSource(sessions, "codex", [running], 2_000);
    expect(Object.keys(sessions)).toEqual(["01", "02"]);
    sessions = replaceSessionSource(sessions, "codex", [running], 21_001);
    expect(Object.keys(sessions)).toEqual(["01"]);
    const completedOnly = applySessionEvent({}, done, 1_000, "codex");
    expect(groupWorkstreams(completedOnly, 21_001)).toHaveLength(0);
  });

  it("removes ghost agents when an authoritative source becomes empty", () => {
    const running = event("01", "project", "thinking", "Planning");
    running.meta = { ...running.meta, source: "codex-desktop-fallback" };
    let sessions = replaceSessionSnapshot({}, [running], ["codex-desktop-fallback"], 1_000);
    expect(Object.keys(sessions)).toEqual(["01"]);
    sessions = replaceSessionSnapshot(sessions, [], ["codex-desktop-fallback"], 2_000);
    expect(sessions).toEqual({});
  });

  it("retains recent activity for sessions that remain in a snapshot", () => {
    const first = normalizeSimpleEvent({ status: "thinking", detail: "Planning", meta: { sessionId: "01", threadId: "project" } }, "step-1");
    const second = normalizeSimpleEvent({ status: "testing", detail: "Running tests", meta: { sessionId: "01", threadId: "project" } }, "step-2");
    let sessions = replaceSessionSource({}, "codex", [first], 1_000);
    sessions = replaceSessionSource(sessions, "codex", [first, second], 2_000);
    expect(sessions["01"].state.recent.map((item) => item.id)).toEqual(["step-2", "step-1"]);
  });

  it("starts a resumed session with a fresh display history", () => {
    const previousRun = normalizeSimpleEvent({
      status: "complete",
      detail: "Previous work finished",
      meta: { sessionId: "01", threadId: "project", turnId: "old-turn", lastMessage: "The old final response" },
    }, "old-final");
    const resumedRun = normalizeSimpleEvent({
      status: "thinking",
      detail: "New request received",
      meta: { sessionId: "01", threadId: "project", turnId: "new-turn" },
    }, "new-start");
    let sessions = replaceSessionSource({}, "codex", [previousRun], 1_000);
    sessions = replaceSessionSource(sessions, "codex", [resumedRun], 2_000);
    expect(sessions["01"].runId).toBe("new-turn");
    expect(sessions["01"].lastMessage).toBe("");
    expect(sessions["01"].state.detail).toBe("New request received");
    expect(sessions["01"].state.recent.map((item) => item.id)).toEqual(["new-start"]);
  });

  it("does not resurrect a terminal session when older history is backfilled", () => {
    const older = normalizeSimpleEvent({ status: "thinking", detail: "Earlier planning", meta: { sessionId: "01", threadId: "project" } }, "older");
    const done = normalizeSimpleEvent({ status: "complete", detail: "Finished", meta: { sessionId: "01", threadId: "project" } }, "final");
    let sessions = replaceSessionSource({}, "codex", [done], 1_000);
    sessions = replaceSessionSource(sessions, "codex", [older, done], 2_000);
    expect(sessions["01"].state.status).toBe("complete");
    expect(sessions["01"].state.recent.map((item) => item.id)).toEqual(["final", "older"]);
  });

  it("retains the final agent message for the completion summary", () => {
    const done = normalizeSimpleEvent({ status: "complete", detail: "Finished", meta: { sessionId: "01", threadId: "project", lastMessage: "Implemented the adaptive board." } }, "done");
    const sessions = applySessionEvent({}, done, 1_000, "codex");
    expect(sessions["01"].lastMessage).toBe("Implemented the adaptive board.");
  });

  it("preserves child grouping and model metadata across sparse later events", () => {
    const started = normalizeSimpleEvent({
      status: "thinking",
      meta: {
        sessionId: "child",
        parentSessionId: "root",
        workstreamId: "root",
        workstreamName: "PROJECT",
        model: "gpt-test",
      },
    }, "started");
    const finished = normalizeSimpleEvent({ status: "complete", meta: { sessionId: "child" } }, "finished");
    let sessions = applySessionEvent({}, started, 1_000, "codex-app-server");
    sessions = applySessionEvent(sessions, finished, 2_000, "codex-app-server");
    expect(sessions.child).toMatchObject({ parentSessionId: "root", workstreamId: "root", workstreamName: "PROJECT", model: "gpt-test" });
  });

  it("projects renderer lifecycle states from one shared policy", () => {
    const active = normalizeSimpleEvent({ status: "thinking", meta: { sessionId: "root", threadId: "project" } }, "active");
    const childDone = normalizeSimpleEvent({ status: "complete", meta: { sessionId: "child", parentSessionId: "root", threadId: "project" } }, "child-done");
    let sessions = applySessionEvent({}, active, 1_000, "codex-hooks");
    sessions = applySessionEvent(sessions, childDone, 2_000, "codex-hooks");
    const presentation = projectWorkstreamPresentation(groupWorkstreams(sessions, 2_000), 2_000);
    expect(presentation.liveAgents).toHaveLength(1);
    expect(presentation.boardWorkstreams[0].agents).toHaveLength(2);
    expect(presentation.completedRootAgents).toEqual([]);
    expect(presentation.recentlyDone).toBe(1);
  });
});
