import { describe, expect, it } from "vitest";
import { animatedStateForStatus, personalityColor, personalityShape } from "./animatedFaceModel";

describe("animated face app-state mapping", () => {
  it("maps each active work state to a deliberate expression", () => {
    expect(animatedStateForStatus("idle")).toBe("idle");
    expect(animatedStateForStatus("thinking")).toBe("thinking");
    expect(animatedStateForStatus("searching")).toBe("searching");
    expect(animatedStateForStatus("working")).toBe("working");
    expect(animatedStateForStatus("command")).toBe("sending");
    expect(animatedStateForStatus("editing")).toBe("writing");
    expect(animatedStateForStatus("testing")).toBe("progress");
    expect(animatedStateForStatus("waiting")).toBe("listening");
    expect(animatedStateForStatus("complete")).toBe("celebrate");
    expect(animatedStateForStatus("error")).toBe("alerting");
  });

  it("makes attention and approval visibly attentive", () => {
    expect(animatedStateForStatus("idle", true)).toBe("listening");
    expect(animatedStateForStatus("approval")).toBe("listening");
    expect(animatedStateForStatus("error", true)).toBe("alerting");
  });

  it("selects stable, valid visual identities", () => {
    expect(personalityShape(3)).toBe(personalityShape(3));
    expect(personalityColor(3)).toBe(personalityColor(3));
    expect(personalityShape(-1)).toBe("pebble");
    expect(personalityColor(-1)).toBe("green");
  });
});
