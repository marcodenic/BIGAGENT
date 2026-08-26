import { describe, expect, it } from "vitest";
import { codexAdapter, genericJsonlAdapter } from "./adapters";
describe("adapters", () => {
  it("normalizes simple protocol events", () => expect(genericJsonlAdapter.ingest({ status: "testing", label: "Test suite" })?.status).toBe("testing"));
  it("rejects malformed events", () => expect(genericJsonlAdapter.ingest("hello")).toBeNull());
  it("maps observable Codex test activity", () => expect(codexAdapter.ingest({ type: "command.started", command: "pnpm test" })?.status).toBe("testing"));
  it("keeps observable tool names for the ambient activity roster", () => expect(codexAdapter.ingest({ type: "file_change", changes: [{ path: "src/main.tsx" }] })?.tool).toBe("apply_patch"));
  it("keeps public structured plan steps", () => expect(codexAdapter.ingest({ type: "plan.updated", steps: [{ content: "Verify the display" }] })?.plan).toEqual(["Verify the display"]));
  it("separates Codex thread and turn lifecycle boundaries", () => {
    expect(codexAdapter.ingest({ type: "thread.started" })).toMatchObject({ kind: "session.start", status: "idle" });
    expect(codexAdapter.ingest({ type: "turn.completed" })).toMatchObject({ kind: "turn.end", status: "idle" });
    expect(codexAdapter.ingest({ type: "thread.closed" })).toMatchObject({ kind: "session.end", status: "complete" });
  });
});
