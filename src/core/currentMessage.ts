import { displayText } from "./displayText";
import type { AgentEvent } from "./protocol";
import type { AgentSession } from "./workstreams";

export function usefulMessage(value: string) {
  const text = displayText(value, "");
  return /^(?:planning (?:the )?next step|thinking|working|waiting for (?:an? )?agent|running(?: command)?|processing (?:a )?result)[.!…\s]*$/i.test(text) ? "" : text;
}

/** Retain public updates, never command bodies or generic transport status. */
export function narrativeMessage(event: AgentEvent) {
  if (event.meta?.activityClass === "narrative" || event.kind === "reasoning.summary"
    || (event.kind === "activity" && event.meta?.activityClass !== "telemetry" && !event.tool && !event.command)) {
    return usefulMessage(event.detail ?? "");
  }
  return "";
}

export function currentMessage(agent: AgentSession, privacy: boolean) {
  if (privacy) return "Agent activity in progress";
  // Requests, failures and terminal outcomes must not be hidden by an older update.
  if (agent.state.attention || agent.state.status === "complete" || agent.state.status === "stopped") {
    return displayText(agent.state.detail, agent.state.label);
  }
  return agent.latestNarrative || usefulMessage(agent.lastMessage) || "";
}
