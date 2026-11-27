import { describe, expect, it } from "vitest";
import { normalizeSimpleEvent } from "./protocol";
import { currentMessage } from "./currentMessage";
import { applySessionEvent, replaceSessionSnapshot } from "./workstreams";

const message = normalizeSimpleEvent({ status: "working", detail: "The server is still listening inside the VM.", meta: { sessionId: "agent", turnId: "one", activityClass: "narrative" } }, "message");
const planning = normalizeSimpleEvent({ status: "thinking", detail: "Planning the next step", meta: { sessionId: "agent", turnId: "one", activityClass: "narrative" } }, "planning");

describe("current agent message", () => {
  it("keeps the useful update through planning and more than a full history of tool events", () => {
    let sessions = applySessionEvent({}, message);
    sessions = applySessionEvent(sessions, planning);
    for (let i = 0; i < 90; i++) {
      sessions = applySessionEvent(sessions, normalizeSimpleEvent({ status: "command", command: "private command", meta: { sessionId: "agent", turnId: "one", activityClass: "telemetry" } }, `tool-${i}`));
    }
    expect(sessions.agent.state.recent).toHaveLength(80);
    expect(currentMessage(sessions.agent, false)).toBe(message.detail);
    expect(currentMessage(sessions.agent, true)).toBe("Agent activity in progress");
  });

  it("updates the message when a new narrative arrives and clears it for a new run", () => {
    let sessions = applySessionEvent({}, message);
    sessions = applySessionEvent(sessions, { ...message, id: "new-message", detail: "The tests now pass." });
    expect(currentMessage(sessions.agent, false)).toBe("The tests now pass.");
    sessions = applySessionEvent(sessions, message);
    expect(currentMessage(sessions.agent, false)).toBe("The tests now pass.");
    sessions = applySessionEvent(sessions, { ...planning, id: "new-turn", kind: "turn.start", meta: { ...planning.meta, turnId: "two" } });
    expect(currentMessage(sessions.agent, false)).toBe("");
  });

  it("preserves the message across a status-only snapshot of the same run", () => {
    const sessions = applySessionEvent({}, message, Date.now(), "codex-desktop-fallback");
    const next = replaceSessionSnapshot(sessions, [{ ...planning, meta: { ...planning.meta, source: "codex-desktop-fallback" } }], ["codex-desktop-fallback"]);
    expect(currentMessage(next.agent, false)).toBe(message.detail);
  });

  it("supports plain public activity updates without a narrative annotation", () => {
    const plain = { ...message, meta: { sessionId: "agent", turnId: "one" } };
    const sessions = applySessionEvent({}, plain);
    expect(currentMessage(sessions.agent, false)).toBe(message.detail);
  });

  it.each(["waiting", "approval", "error", "complete", "stopped"] as const)("prioritizes %s over an older update", status => {
    const sessions = applySessionEvent(applySessionEvent({}, message), normalizeSimpleEvent({ status, detail: "The current outcome needs attention.", meta: { sessionId: "agent", turnId: "one" } }, status));
    expect(currentMessage(sessions.agent, false)).toBe("The current outcome needs attention.");
    expect(currentMessage(sessions.agent, true)).toBe("Agent activity in progress");
  });
});
