/** Public, agent-neutral event protocol. Never includes private reasoning. */
export type AgentStatus = "idle" | "thinking" | "searching" | "working" | "command" | "editing" | "testing" | "waiting" | "approval" | "complete" | "error";
/** Provider-neutral activity detail. Status remains the compact UI grouping. */
export type AgentPhase = "idle" | "starting" | "planning" | "searching" | "executing" | "editing" | "testing" | "waiting" | "responding" | "delegating" | "retrying" | "receiving" | "uploading" | "notifying" | "completing" | "failed";
export type EventKind = "session.start" | "session.end" | "turn.start" | "turn.end" | "activity" | "reasoning.summary" | "plan" | "command.start" | "command.end" | "files.changed" | "test.result" | "approval.requested" | "input.requested" | "error" | "complete" | "usage";

export interface AgentEvent {
  version: 1; id: string; timestamp: string; kind: EventKind; status?: AgentStatus;
  label?: string; detail?: string; phase?: AgentPhase; files?: string[]; command?: string; tool?: string; target?: string; exitCode?: number;
  plan?: string[]; usage?: { inputTokens?: number; outputTokens?: number }; meta?: Record<string, unknown>;
}

export const statuses: AgentStatus[] = ["idle", "thinking", "searching", "working", "command", "editing", "testing", "waiting", "approval", "complete", "error"];
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<AgentEvent>;
  return e.version === 1 && typeof e.id === "string" && typeof e.timestamp === "string" && typeof e.kind === "string";
}

/** Convenience JSONL shape accepted by `big-agent emit` and the local protocol. */
export interface SimpleEvent { status: AgentStatus; label?: string; detail?: string; phase?: AgentPhase; files?: string[]; command?: string; tool?: string; target?: string; exitCode?: number; meta?: Record<string, unknown> }
export function normalizeSimpleEvent(value: SimpleEvent, id: string = crypto.randomUUID()): AgentEvent {
  const kind: EventKind = value.status === "complete" ? "complete" : value.status === "error" ? "error" : value.status === "approval" ? "approval.requested" : value.status === "waiting" ? "input.requested" : value.status === "command" ? "command.start" : value.status === "editing" ? "files.changed" : "activity";
  return { version: 1, id, timestamp: new Date().toISOString(), kind, ...value };
}
