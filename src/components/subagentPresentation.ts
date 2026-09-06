import type { AgentSession } from "../core/workstreams";
import { faceHash, type AnimatedFaceColor } from "./animatedFaceModel";

const fallbackColors: AnimatedFaceColor[] = ["blue", "cyan", "violet", "magenta", "green", "yellow"];

/** Only explicit roles carry semantic colours; task names never imply a role. */
export function subagentColor(agent: Pick<AgentSession, "id" | "agentRole">): AnimatedFaceColor {
  const role = agent.agentRole?.trim().toLowerCase();
  if (role === "explorer") return "cyan";
  if (role === "worker") return "violet";
  if (role === "reviewer") return "yellow";
  if (role === "default") return "blue";
  return fallbackColors[faceHash(role || agent.id) % fallbackColors.length];
}

export function subagentAssignment(agent: Pick<AgentSession, "agentPath" | "agentTaskTitle" | "agentRole">) {
  const name = agent.agentPath?.split("/").filter(Boolean).pop();
  if (name && name !== "root") {
    const words = name.replace(/[_-]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return agent.agentTaskTitle?.trim() || agent.agentRole?.trim() || "";
}
