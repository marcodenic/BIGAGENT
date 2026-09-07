import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompletionSoundGate, createCompletionSoundScheduler } from "./completionSound";

describe("completion sound delay", () => {
  afterEach(() => vi.useRealTimers());

  it("waits two seconds, cancels on resumed work, and plays once after the next completion", () => {
    vi.useFakeTimers();
    const scheduler = createCompletionSoundScheduler();
    const play = vi.fn();
    scheduler.update("running", true, false, play);
    scheduler.update("complete", true, true, play);
    vi.advanceTimersByTime(1_999);
    expect(play).not.toHaveBeenCalled();
    scheduler.update("running", true, false, play);
    vi.advanceTimersByTime(5_000);
    expect(play).not.toHaveBeenCalled();
    scheduler.update("complete", true, true, play);
    vi.advanceTimersByTime(1_000);
    scheduler.update("complete", true, true, play);
    vi.advanceTimersByTime(1_000);
    expect(play).toHaveBeenCalledTimes(1);
    scheduler.update("complete", true, true, play);
    vi.advanceTimersByTime(5_000);
    expect(play).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it.each(["mute", "hide", "interrupt", "unmount"])("cancels pending audio on %s", (reason) => {
    vi.useFakeTimers();
    const scheduler = createCompletionSoundScheduler();
    const play = vi.fn();
    scheduler.update("running", true, false, play);
    scheduler.update("complete", true, true, play);
    vi.advanceTimersByTime(1_000);
    if (reason === "unmount") scheduler.dispose();
    else scheduler.update(reason === "interrupt" ? "interrupted" : "complete", reason !== "mute", reason !== "hide", play);
    vi.advanceTimersByTime(2_000);
    expect(play).not.toHaveBeenCalled();
    scheduler.update("complete", true, true, play);
    vi.advanceTimersByTime(2_000);
    expect(play).not.toHaveBeenCalled();
    scheduler.dispose();
  });
});

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
