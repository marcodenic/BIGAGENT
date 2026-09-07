import { describe, expect, it } from "vitest";
import { createCompletionSoundGate } from "./completionSound";

describe("completion sound", () => {
  it("plays once per observed run, including another run without a reload", () => {
    const update = createCompletionSoundGate();
    expect(update(undefined, true, false)).toBe(false);
    expect(update("running", true, false)).toBe(false);
    expect(update("complete", true, true)).toBe(true);
    expect(update("complete", true, true)).toBe(false);
    expect(update("complete", true, false)).toBe(false);
    expect(update("complete", true, true)).toBe(false);
    update("running", true, false);
    expect(update("complete", true, true)).toBe(true);
  });

  it("does not announce historical completion or interruption", () => {
    const update = createCompletionSoundGate();
    expect(update("complete", true, true)).toBe(false);
    update("running", true, false);
    expect(update("interrupted", true, false)).toBe(false);
    expect(update("complete", true, true)).toBe(false);
  });

  it.each([[false, true], [true, false]])("consumes completion when enabled=%s and visible=%s", (enabled, visible) => {
    const update = createCompletionSoundGate();
    update("running", enabled, false);
    expect(update("complete", enabled, visible)).toBe(false);
    expect(update("complete", true, true)).toBe(false);
  });
});
