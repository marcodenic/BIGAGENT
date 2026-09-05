import type { AgentPhase, AgentStatus } from "../core/protocol";

export type AnimatedFaceShape = "blob" | "pebble" | "bean" | "egg" | "squircle" | "tablet" | "capsule" | "cylinder" | "hex" | "gem" | "crystal" | "wedge" | "shield" | "dome" | "arch" | "cloud" | "teardrop" | "leaf";
export type AnimatedFaceColor = "black" | "brown" | "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "violet" | "magenta" | "gray";
export type AnimatedFaceState = "sleeping" | "waking" | "idle" | "listening" | "thinking" | "searching" | "working" | "excited" | "surprised" | "suspicious" | "angry" | "drowsy" | "happy" | "curious" | "confused" | "bored" | "proud" | "shy" | "sad" | "laughing" | "scared" | "playful" | "celebrate" | "orbit" | "radar" | "progress" | "spawning" | "humming" | "loading" | "dictating" | "writing" | "sending" | "receiving" | "uploading" | "notifying" | "alerting" | "dragging" | "bouncing" | "powering-down";

/** Exact Grok Bot 0.18 light-theme palette values from the shipped renderer. */
export const OFFICIAL_GROK_COLORS: Record<AnimatedFaceColor, { from: string; to: string; flat: string }> = {
  black: { from: "#585858", to: "#000000", flat: "#000000" },
  brown: { from: "#AE8968", to: "#855C36", flat: "#A27952" },
  red: { from: "#FF5667", to: "#E02135", flat: "#FF3E51" },
  orange: { from: "#FF8838", to: "#E05B00", flat: "#FF781C" },
  yellow: { from: "#FFAF38", to: "#E08600", flat: "#FFAF38" },
  green: { from: "#1CCF82", to: "#009957", flat: "#00C972" },
  cyan: { from: "#58D3C5", to: "#00A592", flat: "#1CC3B0" },
  blue: { from: "#459FFE", to: "#0E74E0", flat: "#2A92FE" },
  violet: { from: "#B792FE", to: "#804EE0", flat: "#A97EFE" },
  magenta: { from: "#FF77BE", to: "#E02A88", flat: "#FF5EB1" },
  gray: { from: "#A6A6A6", to: "#696969", flat: "#959595" },
};

/** App events are only translated here; all motion remains inside the shipped engine. */
export function animatedStateForStatus(status: AgentStatus, attention = false, phase?: AgentPhase): AnimatedFaceState {
  if (status === "error") return "alerting";
  if (status === "approval" || attention) return "listening";
  switch (phase) {
    case "starting": return "waking";
    case "responding": return "dictating";
    case "delegating": return "spawning";
    case "retrying": return "loading";
    case "receiving": return "receiving";
    case "uploading": return "uploading";
    case "notifying": return "notifying";
    case "completing": return "celebrate";
    case "failed": return "alerting";
  }
  switch (status) {
    case "thinking": return "thinking";
    case "searching": return "searching";
    case "working": return "working";
    case "command": return "sending";
    case "editing": return "writing";
    case "testing": return "progress";
    case "waiting": return "listening";
    case "complete": return "celebrate";
    default: return "idle";
  }
}

const SHAPES: readonly AnimatedFaceShape[] = ["blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder", "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf"];
// One random salt per app launch. Deriving colours from it preserves identity
// across rerenders, layout changes, and a remounted completion screen.
const colorSessionSeed = crypto.getRandomValues(new Uint32Array(1))[0];

/** Preserve assigned colours, choosing a well-separated hue for each newcomer. */
export function createPersonalityPaletteAllocator(sessionSeed: number) {
  const assigned = new Map<number, { hue: number; palette: { from: string; to: string; flat: string } }>();
  return (personality: number) => {
    const existing = assigned.get(personality);
    if (existing) return existing.palette;
    const sample = (channel: string) => faceHash(`${sessionSeed}:${personality}:${channel}`) / 0x100000000;
    let hue = sample("hue") * 360;
    const hues = [...assigned.values()].map(value => value.hue).sort((a, b) => a - b);
    const distance = (other: number) => Math.min(Math.abs(hue - other), 360 - Math.abs(hue - other));
    if (hues.some(other => distance(other) < 45)) {
      // Split the largest free arc, including the arc crossing red at 0°.
      // As the cast grows, use the best available separation without recolouring it.
      let largest = -1;
      for (let index = 0; index < hues.length; index++) {
        const start = hues[index];
        const end = hues[(index + 1) % hues.length] + (index === hues.length - 1 ? 360 : 0);
        if (end - start > largest) {
          largest = end - start;
          hue = (start + largest / 2) % 360;
        }
      }
    }
    const saturation = 70 + sample("saturation") * 18;
    const lightness = 58 + sample("lightness") * 6;
    const hsl = (light: number) => `hsl(${hue.toFixed(2)} ${saturation.toFixed(2)}% ${light.toFixed(2)}%)`;
    const palette = { from: hsl(lightness + 5), to: hsl(lightness - 9), flat: hsl(lightness) };
    assigned.set(personality, { hue, palette });
    return palette;
  };
}

export const personalityPalette = createPersonalityPaletteAllocator(colorSessionSeed);

export function personalityShape(personality: number): AnimatedFaceShape {
  return SHAPES[Math.abs(personality) % SHAPES.length];
}

export function faceHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
