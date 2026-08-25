import { describe, expect, it } from "vitest";
import { normalizeSimpleEvent } from "./protocol";
import { applySessionEvent, groupWorkstreams, replaceSessionSource } from "./workstreams";

function event(sessionId: string, threadId: string, status: "thinking" | "testing" | "waiting" | "complete", detail: string) {
  return normalizeSimpleEvent({ status, detail, meta: { sessionId, threadId, workstreamName: "PROPER LINUX", agentName: `Agent ${sessionId}` } }, sessionId);
}

describe("workstream projection", () => {
  it("groups several sessions into one stable workstream", () => {
    let sessions = applySessionEvent({}, event("01", "project", "thinking", "Planning"), 1_000, "codex");
    sessions = applySessionEvent(sessions, event("02", "project", "testing", "Running tests"), 2_000, "codex");
    const workstreams = groupWorkstreams(sessions, 2_000);
    expect(workstreams).toHaveLength(1);
    expect(workstreams[0].agents).toHaveLength(2);
    expect(workstreams[0].label).toBe("WORKING");
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

  it("reconciles snapshots and ages completed work out", () => {
    const running = event("01", "project", "thinking", "Planning");
    const done = event("02", "done", "complete", "Finished");
    let sessions = replaceSessionSource({}, "codex", [running, done], 1_000);
    expect(groupWorkstreams(sessions, 1_000)).toHaveLength(2);
    sessions = replaceSessionSource(sessions, "codex", [running], 2_000);
    expect(Object.keys(sessions)).toEqual(["01"]);
    const completedOnly = applySessionEvent({}, done, 1_000, "codex");
    expect(groupWorkstreams(completedOnly, 21_001)).toHaveLength(0);
  });

  it("retains recent activity for sessions that remain in a snapshot", () => {
    const first = normalizeSimpleEvent({ status: "thinking", detail: "Planning", meta: { sessionId: "01", threadId: "project" } }, "step-1");
    const second = normalizeSimpleEvent({ status: "testing", detail: "Running tests", meta: { sessionId: "01", threadId: "project" } }, "step-2");
    let sessions = replaceSessionSource({}, "codex", [first], 1_000);
    sessions = replaceSessionSource(sessions, "codex", [first, second], 2_000);
    expect(sessions["01"].state.recent.map((item) => item.id)).toEqual(["step-2", "step-1"]);
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
});
