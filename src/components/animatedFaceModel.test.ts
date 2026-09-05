import { describe, expect, it } from "vitest";
import { animatedStateForStatus, createPersonalityPaletteAllocator, personalityPalette, personalityShape } from "./animatedFaceModel";

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

  it("uses shipped effects only for telemetry phases with matching meaning", () => {
    expect(animatedStateForStatus("thinking", false, "starting")).toBe("waking");
    expect(animatedStateForStatus("working", false, "responding")).toBe("dictating");
    expect(animatedStateForStatus("working", false, "delegating")).toBe("spawning");
    expect(animatedStateForStatus("thinking", false, "retrying")).toBe("loading");
    expect(animatedStateForStatus("working", false, "receiving")).toBe("receiving");
    expect(animatedStateForStatus("working", false, "uploading")).toBe("uploading");
    expect(animatedStateForStatus("working", false, "notifying")).toBe("notifying");
  });

  it("selects stable, valid visual identities", () => {
    expect(personalityShape(3)).toBe(personalityShape(3));
    expect(personalityPalette(3)).toEqual(personalityPalette(3));
    expect(personalityShape(-1)).toBe("pebble");
    expect(new Set(Array.from({ length: 90 }, (_, identity) => personalityShape(identity))).size).toBe(18);
    const allocate = createPersonalityPaletteAllocator(42);
    const palettes = Array.from({ length: 90 }, (_, identity) => allocate(identity));
    expect(new Set(palettes.map(palette => palette.flat)).size).toBe(90);
    expect(allocate(3)).not.toEqual(createPersonalityPaletteAllocator(43)(3));
    for (const palette of palettes) {
      for (const color of Object.values(palette)) {
        const [hue, saturation, lightness] = color.match(/[\d.]+/g)!.map(Number);
        expect(hue).toBeGreaterThanOrEqual(0);
        expect(hue).toBeLessThanOrEqual(360);
        expect(saturation).toBeGreaterThanOrEqual(70);
        expect(saturation).toBeLessThanOrEqual(88);
        expect(lightness).toBeGreaterThanOrEqual(49);
        expect(lightness).toBeLessThanOrEqual(69);
      }
    }
  });
});


it("separates a nine-character cast without changing existing identities", () => {
  for (const seed of [0, 42, 123456, 0xffffffff]) {
    const allocate = createPersonalityPaletteAllocator(seed);
    const identities = [3791079978, 3361716846, 3, 4, 5, 6, 7, 8, 9];
    const palettes = identities.map(allocate);
    const hues = palettes.map(palette => Number(palette.flat.match(/[\d.]+/)![0]));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const difference = Math.abs(hues[i] - hues[j]);
        expect(Math.min(difference, 360 - difference)).toBeGreaterThanOrEqual(20);
      }
      expect(allocate(identities[i])).toBe(palettes[i]);
    }
  }
});
