import { describe, expect, it } from "vitest";
import { earliestTimeout } from "./idle-timeout";
describe("idle timeout selection", () => {
  it("uses the earliest enabled timeout", () => expect(earliestTimeout([0, 600, 180])).toBe(180));
  it("respects disabled system timers", () => expect(earliestTimeout([0, undefined])).toBe(Infinity));
  it("falls back only when settings are unavailable", () => expect(earliestTimeout([undefined, NaN])).toBe(300));
});
