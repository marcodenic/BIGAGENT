import { describe, expect, it } from "vitest";
import { normalizeSimpleEvent } from "./protocol";
import { elapsedMs, initialState, reduceEvent } from "./reducer";

describe("display reducer", () => {
  it("moves through activity and preserves file changes", () => {
    const e = normalizeSimpleEvent({ status: "editing", files: ["auth.ts", "session.ts"] }, "edit");
    const state = reduceEvent(initialState, e, 1000);
    expect(state.status).toBe("editing"); expect(state.label).toBe("EDITING 2 FILES"); expect(state.files).toEqual(["auth.ts", "session.ts"]); expect(state.startedAt).toBe(1000);
  });
  it("makes approval states unmistakably attention seeking", () => {
    const state = reduceEvent(initialState, normalizeSimpleEvent({ status: "approval", detail: "Permission required" }, "approve"));
    expect(state.attention).toBe(true); expect(state.label).toBe("NEEDS YOU");
  });
  it("handles completion and freezes elapsed time", () => {
    const active = reduceEvent(initialState, normalizeSimpleEvent({ status: "thinking" }, "start"), 1_000);
    const done = reduceEvent(active, normalizeSimpleEvent({ status: "complete", detail: "all set" }, "done"), 9_000);
    expect(done.status).toBe("complete"); expect(elapsedMs(done, 20_000)).toBe(8_000);
  });
  it("handles crashes and duplicate events", () => {
    const event = normalizeSimpleEvent({ status: "command", exitCode: 1, detail: "process exited" }, "bad"); const error = reduceEvent(initialState, event);
    expect(error.status).toBe("error"); expect(error.attention).toBe(true); expect(reduceEvent(error, event)).toBe(error);
  });
  it("enforces lifecycle boundaries when status is omitted", () => {
    const turnStart = { version: 1 as const, id: "turn-start", timestamp: "", kind: "turn.start" as const };
    const turnEnd = { version: 1 as const, id: "turn-end", timestamp: "", kind: "turn.end" as const };
    const sessionEnd = { version: 1 as const, id: "session-end", timestamp: "", kind: "session.end" as const };
    const active = reduceEvent(initialState, turnStart, 1_000);
    const turnComplete = reduceEvent(active, turnEnd, 2_000);
    const complete = reduceEvent(turnComplete, sessionEnd, 3_000);
    expect(active.status).toBe("thinking");
    expect(turnComplete).toMatchObject({ status: "complete", label: "DONE", completionScope: "turn" });
    expect(reduceEvent(initialState, { ...turnEnd, id: "ambient-turn-end" }, 2_000)).toMatchObject({ status: "idle", completionScope: "none" });
    expect(complete.status).toBe("complete");
    expect(complete.completionScope).toBe("session");
  });
});
