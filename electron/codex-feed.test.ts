import { describe, expect, it } from "vitest";
import { uncoveredCodexEvents } from "./codex-feed";

const event = (threadId: string, turnId: string) => ({ meta: { threadId, turnId } });

describe("Codex desktop and shared server coexistence", () => {
  it("keeps desktop activity when another server reports an unrelated task", () => {
    const desktop = event("desktop", "turn-1");
    expect(uncoveredCodexEvents([desktop], [event("cli", "turn-2")])).toEqual([desktop]);
  });
  it("lets the live feed own the matching turn, including its completion", () => {
    expect(uncoveredCodexEvents([event("task", "turn-1")], [event("task", "turn-1")])).toEqual([]);
  });
  it("keeps a newer desktop turn after an earlier shared turn completed", () => {
    const desktop = event("task", "turn-2");
    expect(uncoveredCodexEvents([desktop], [event("task", "turn-1")])).toEqual([desktop]);
  });
  it("does not suppress desktop activity for server messages without a turn", () => {
    const desktop = event("task", "turn-1");
    expect(uncoveredCodexEvents([desktop], [{ meta: { threadId: "task" } }])).toEqual([desktop]);
  });
});
