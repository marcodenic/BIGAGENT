import { displayText } from "./displayText";
import type { AgentEvent } from "./protocol";
import type { AgentSession } from "./workstreams";

export interface MessageStream {
  id: string;
  chunks: Record<number, string>;
}

/** MessageDisplay delivers new lines, not the full message; its final delta
 * can be empty. Keep batches independently so retries and reordered delivery
 * cannot duplicate or discard text. Retain at most 64 KiB for display. */
export function streamedMessage(event: AgentEvent, previous?: MessageStream) {
  const id = event.meta?.messageId;
  const index = event.meta?.messageIndex;
  const delta = event.meta?.messageDelta;
  if (typeof id !== "string" || typeof index !== "number" || !Number.isInteger(index) || index < 0
    || typeof delta !== "string") return undefined;
  const chunks = { ...(previous?.id === id ? previous.chunks : {}), [index]: delta };
  const retained: Record<number, string> = {};
  let text = "";
  for (const key of Object.keys(chunks).map(Number).sort((a, b) => a - b).slice(0, 1024)) {
    const chunk = chunks[key].slice(0, 65_536 - text.length);
    retained[key] = chunk;
    text += chunk;
    if (text.length === 65_536) break;
  }
  return { stream: { id, chunks: retained }, text: usefulMessage(text) };
}

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
