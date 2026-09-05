import { describe, expect, it } from "vitest";
import { initialState } from "./reducer";
import type { AgentSession } from "./workstreams";
import { advanceRunRecap } from "./runRecap";
function agent(id: string, status: AgentSession["state"]["status"], time = 1000, runId = "turn-1"): AgentSession {
  return { id, runId, source: "hooks", parentSessionId: id === "child" ? "root" : "", workstreamId: "project", workstreamName: "Project", sessionTitle: "", agentName: id, modelProvider: "test", model: "test", effort: "", lastMessage: "", updatedAt: time,
    state: { ...initialState, status, startedAt: 1000, endedAt: status === "complete" ? time : null, completionScope: "turn" } };
}
describe("run recap", () => {
  it("keeps early completed children after snapshots remove them, counting distinct agents and wall time", () => {
    let recap = advanceRunRecap(null, { root: agent("root", "working"), child: agent("child", "working") }, 1000);
    recap = advanceRunRecap(recap, { root: agent("root", "working"), child: agent("child", "complete", 2000) }, 2000);
    recap = advanceRunRecap(recap, { root: agent("root", "working", 30000) }, 30000);
    recap = advanceRunRecap(recap, { root: agent("root", "complete", 40000) }, 40000);
    expect(recap?.status).toBe("complete");
    expect(Object.keys(recap!.participants)).toEqual(["root", "child"]);
    expect(recap!.endedAt! - recap!.startedAt).toBe(39000);
    expect(advanceRunRecap(recap, {}, 100000)).toBe(recap);
  });
  it.each(["waiting", "approval", "error", "idle"] as const)("does not celebrate %s", status => {
    const recap = advanceRunRecap(null, { root: agent("root", "working") }, 1000);
    expect(advanceRunRecap(recap, { root: agent("root", status) }, 2000)?.status).not.toBe("complete");
  });
  it("never turns a missing feed into success, and can start fresh when work returns", () => {
    let recap = advanceRunRecap(null, { root: agent("root", "working") }, 1000);
    recap = advanceRunRecap(recap, {}, 2000);
    expect(recap?.status).toBe("interrupted");
    recap = advanceRunRecap(recap, { next: agent("next", "working", 3000) }, 3000);
    expect(Object.keys(recap!.participants)).toEqual(["next"]);
  });
  it("does not create a recap from historical completions or idle sessions", () => {
    expect(advanceRunRecap(null, { root: agent("root", "complete") }, 10000)).toBeNull();
    expect(advanceRunRecap(null, { root: agent("root", "idle") }, 10000)).toBeNull();
  });
  it("starts a new cast when a completed session resumes and ignores old terminal rows", () => {
    let recap = advanceRunRecap(null, { root: agent("root", "working"), child: agent("child", "working") }, 1000);
    recap = advanceRunRecap(recap, { root: agent("root", "complete", 2000), child: agent("child", "complete", 2000) }, 2000);
    recap = advanceRunRecap(recap, { root: agent("root", "working", 3000, "turn-2"), child: agent("child", "complete", 2000) }, 3000);
    expect(recap?.status).toBe("running");
    expect(Object.keys(recap!.participants)).toEqual(["root"]);
  });
  it("does not count repeated updates and turns while a sibling remains active twice", () => {
    let recap = advanceRunRecap(null, { root: agent("root", "working"), child: agent("child", "working") }, 1000);
    recap = advanceRunRecap(recap, { root: agent("root", "complete", 2000), child: agent("child", "working") }, 2000);
    recap = advanceRunRecap(recap, { root: agent("root", "working", 3000, "turn-2"), child: agent("child", "working") }, 3000);
    expect(Object.keys(recap!.participants)).toHaveLength(2);
  });
});
