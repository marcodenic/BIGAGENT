import type { AgentStatus } from "../core/protocol";

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
export function animatedStateForStatus(status: AgentStatus, attention = false): AnimatedFaceState {
  if (status === "error") return "alerting";
  if (status === "approval" || attention) return "listening";
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
const COLORS: readonly AnimatedFaceColor[] = ["yellow", "green", "cyan", "blue", "violet", "magenta", "orange", "red", "brown", "gray"];

export function personalityColor(personality: number): AnimatedFaceColor {
  return COLORS[Math.abs(personality) % COLORS.length];
}

export function personalityShape(personality: number): AnimatedFaceShape {
  return SHAPES[Math.abs(personality) % SHAPES.length];
}
